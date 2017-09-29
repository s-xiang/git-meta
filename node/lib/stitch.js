#!/usr/bin/env node
/*
 * Copyright (c) 2017, Two Sigma Open Source
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * * Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * * Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * * Neither the name of git-meta nor the names of its
 *   contributors may be used to endorse or promote products derived from
 *   this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * This module contains the entrypoint for the `git-meta` program.  All 
 * significant functionality is deferred to the sub-commands.
 */

const ArgumentParser = require("argparse").ArgumentParser;
const co             = require("co");
const NodeGit        = require("nodegit");

const GitUtil             = require("./util/git_util");
const SubmoduleUtil       = require("./util/submodule_util");
const TreeUtil            = require("./util/tree_util");

const description = `Stitch together the specified meta-repo commitish in \
the specified repo.`;

const parser = new ArgumentParser({
    addHelp: true,
    description: description
});

parser.addArgument(["-c", "--commitish"], {
    type: "string",
    help: "meta-repo commit to stitch, default is HEAD",
    defaultValue: "HEAD",
    required: false,
});

parser.addArgument(["repo"], {
    type: "string",
    help: "location of the repo, default is \".\"",
    nargs: "?",
    defaultValue: ".",
});

const getCommitSubmodules = co.wrap(function *(repo, commit, cache) {
    const sha = commit.id().tostrS();
    const cached = cache[sha];
    if (undefined !== cached) {
        return cached;
    }
    const subs = yield SubmoduleUtil.getSubmodulesForCommit(repo, commit);
    cache[sha] = subs;
    return subs;
});

const writeMetaCommit = co.wrap(function *(repo,
                                           commit,
                                           parents,
                                           newParents,
                                           commitSubmodules) {

    let parentTree = null;
    let parentSubs = {};
    if (0 !== parents.length) {
        const firstParent = parents[0];
        parentTree = yield firstParent.getTree();
        parentSubs = yield getCommitSubmodules(repo,
                                               firstParent,
                                               commitSubmodules);
    }
    const subs = yield getCommitSubmodules(repo, commit, commitSubmodules);

    // The parents we'll write for this commit will be a list containing first,
    // the converted parents of the commit, then the submodule commits it
    // introduced.

    const parentsToWrite = newParents.slice();
    const changes = {};

    // changes and additions

    for (let name in subs) {
        const newSub = subs[name];
        const newSha = newSub.sha;
        const parentSub = parentSubs[name];
        if (undefined === parentSub || newSha !== parentSub.sha) {
            // TODO: we need to do a fetch here or something to get the
            // relevant sub commits into the target repo.  For now, assume
            // they're present.
            const subCommit = yield repo.getCommit(newSha);
            const subTreeId = subCommit.treeId();
            const FILEMODE = NodeGit.TreeEntry.FILEMODE;
            changes[name] = new TreeUtil.Change(subTreeId, FILEMODE.TREE);
            parentsToWrite.push(subCommit);
        }
    }

    // deletions

    for (let name in parentSubs) {
        if (!(name in subs)) {
            changes[name] = null;
        }
    }

    const newTree = yield TreeUtil.writeTree(repo, parentTree, changes);
    const newCommitId = yield NodeGit.Commit.create(repo,
                                                    null,
                                                    commit.author(),
                                                    commit.committer(),
                                                    commit.messageEncoding(),
                                                    commit.message(),
                                                    newTree,
                                                    parentsToWrite.length,
                                                    parentsToWrite);
    return yield repo.getCommit(newCommitId);
});

function convertedRefName(sha) {
    return `refs/stitched/${sha}`;
}

const getConvertedSha = co.wrap(function *(repo, sha) {

    let ref;
    const refName = convertedRefName(sha);
    try {
        ref = yield NodeGit.Reference.lookup(repo, refName);
    }
    catch (e) {
        return null;
    }
    return ref.target().tostrS();
});

const stitch = co.wrap(function *(repoPath, commitish) {
    const repo = yield NodeGit.Repository.open(repoPath);
    const annotated = yield GitUtil.resolveCommitish(repo, commitish);
    if (null === annotated) {
        throw new Error(`Could not resolve ${commitish}.`);
    }
    const commit = yield repo.getCommit(annotated.id());
    const todo = [commit];
    const commitSubmodules = {};
    while (0 !== todo.length) {
        const next = todo[todo.length - 1];

        // If we had the same commit in the graph more than once, don't convert
        // it more than once.

        const nextSha = next.id().tostrS();
        const converted = yield getConvertedSha(repo, nextSha);
        if (null !== converted) {
            todo.pop();
            continue;                                               // CONTINUE
        }

        let parentsDone = true;
        const parents = yield next.getParents();
        const newParents = [];
        for (let i = 0; i < parents.length; ++i) {
            const parent = parents[i];
            const newParentSha =
                             yield getConvertedSha(repo, parent.id().tostrS());
            if (null === newParentSha) {
                todo.push(parent);
                parentsDone = false;
            }
            else {
                const newParent = yield repo.getCommit(newParentSha);
                newParents.push(newParent);
            }
        }

        // Only of all the parents for this commit have been finished can we
        // actually write a commit.

        if (parentsDone) {
            const newCommit = yield writeMetaCommit(repo,
                                                    next,
                                                    parents,
                                                    newParents,
                                                    commitSubmodules);
            const convertedRef = convertedRefName(nextSha);
            yield NodeGit.Reference.create(repo,
                                           convertedRef,
                                           newCommit.id().tostrS(),
                                           1,
                                           "stitched a ref");
            console.log(nextSha, "->", newCommit.id().tostrS());
            todo.pop();
        }
    }
});

co(function *() {
    try {
        const args = parser.parseArgs();
        yield stitch(args.repo, args.commitish);
    }
    catch (e) {
        console.error(e.stack);
    }
});
