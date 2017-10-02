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
const FILEMODE       = NodeGit.TreeEntry.FILEMODE;

const Commit              = require("./util/commit");
const DoWorkQueue         = require("./util/do_work_queue");
const GitUtil             = require("./util/git_util");
const SubmoduleConfigUtil = require("./util/submodule_config_util");
const SubmoduleUtil       = require("./util/submodule_util");
const TreeUtil            = require("./util/tree_util");

const description = `Stitch together the specified meta-repo commitish in \
the specified repo.`;

const parser = new ArgumentParser({
    addHelp: true,
    description: description
});

parser.addArgument(["-d", "--discard"], {
    required: false,
    action: "storeConst",
    constant: true,
    defaultValue: false,
    help: `If provided, discard submodule commits, do not link them as \
children of the created commits, but instead append their signatures to the \
commit messages of the created commits.`,
});

parser.addArgument(["-p", "--pre-fetch"], {
    required: false,
    action: "storeConst",
    constant: true,
    defaultValue: false,
    help: `If provided, eagerly pre-fetch submodules on head to reduce the \
overall number of fetches needed.  Recommended for initial run but not for
updates.`,
});

parser.addArgument(["-c", "--commitish"], {
    type: "string",
    help: "meta-repo commit to stitch, default is HEAD",
    defaultValue: "HEAD",
    required: false,
});

parser.addArgument(["-u", "--url"], {
    type: "string",
    help: "location of the origin repository where submodules are rooted",
    required: true,
});

parser.addArgument(["-r", "--repo"], {
    type: "string",
    help: "location of the repo, default is \".\"",
    defaultValue: ".",
});

parser.addArgument(["-e", "--exclude"], {
    type: "string",
    help: `submodules whose paths are matched by this regex are not stitched, \
but are instead kept as submodules.`,
    required: false,
    defaultValue: null,
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

const computeModulesFile = co.wrap(function *(repo, parentTree, changedUrls) {
    let urls = {};
    if (null !== parentTree) {
        urls =
             yield SubmoduleConfigUtil.getSubmodulesFromTree(repo, parentTree);
    }
    Object.assign(urls, changedUrls);
    const modulesText = SubmoduleConfigUtil.writeConfigText(urls);
    const db = yield repo.odb();
    const BLOB = 3;
    const id = yield db.write(modulesText, modulesText.length, BLOB);
    return new TreeUtil.Change(id, FILEMODE.BLOB);
});

function summarizeSubCommit(name, url, subCommit) {
    const author = subCommit.author();
    return `\
Includes changes from submodule ${name}
on ${subCommit.id().tostrS()} in ${url}.
Author: ${author.name()} <${author.email()}>
Date:   ${Commit.formatCommitTime(author.when())}

${subCommit.message()}
`;
}

const writeMetaCommit = co.wrap(function *(repo,
                                           commit,
                                           parents,
                                           newParents,
                                           commitSubmodules,
                                           url,
                                           exclude,
                                           detach) {

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
    const changedUrls = {};

    let commitMessage = commit.message();

    // changes and additions

    const doSub = co.wrap(function *(name) {
        const newSub = subs[name];
        const newSha = newSub.sha;
        const parentSub = parentSubs[name];

        // If this is an excluded submodule, record when we need to update the
        // `.gitmodules` file and/or the submodule's sha.

        if (null !== exclude && null !== exclude.exec(name)) {
            if (undefined === parentSub || parentSub.url !== newSub.url) {
                changedUrls[name] = newSub.url;
            }
            if (undefined === parentSub || newSha !== parentSub.sha) {
                const id = NodeGit.Oid.fromString(newSha);
                changes[name] = new TreeUtil.Change(id, FILEMODE.COMMIT);
            }
        }
        else if (undefined === parentSub || newSha !== parentSub.sha) {
            const subUrl =
                      SubmoduleConfigUtil.resolveSubmoduleUrl(url, newSub.url);
            try {
                yield GitUtil.fetchSha(repo, subUrl, newSha);
            }
            catch (e) {
                console.error("On meta-commit", commit.id().tostrS(),
                              name, "is missing", newSha);
                return;                                               // RETURN
            }
            const subCommit = yield repo.getCommit(newSha);
            const subTreeId = subCommit.treeId();
            changes[name] = new TreeUtil.Change(subTreeId, FILEMODE.TREE);

            if (detach) {
                commitMessage += "\n";
                commitMessage += summarizeSubCommit(name, subUrl, subCommit);
            }
            else {
                parentsToWrite.push(subCommit);
            }
        }
    });

    yield DoWorkQueue.doInParallel(Object.keys(subs), doSub, 100);

    // deletions

    for (let name in parentSubs) {
        if (!(name in subs)) {
            changes[name] = null;
        }
    }

    // If we had excluded submodules, update the `.gitmodules` file.

    if (0 !== Object.keys(changedUrls).length) {
        const modulesFile =
                      yield computeModulesFile(repo, parentTree, changedUrls);
        changes[SubmoduleConfigUtil.modulesFileName] = modulesFile;
    }

    const newTree = yield TreeUtil.writeTree(repo, parentTree, changes);
    const newCommitId = yield NodeGit.Commit.create(repo,
                                                    null,
                                                    commit.author(),
                                                    commit.committer(),
                                                    commit.messageEncoding(),
                                                    commitMessage,
                                                    newTree,
                                                    parentsToWrite.length,
                                                    parentsToWrite);
    return yield repo.getCommit(newCommitId);
});

function convertedRefName(sha) {
    const pre = sha.slice(0, 2);
    const post = sha.slice(2);
    return `refs/stitched/${pre}/${post}`;
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

const preFetch = co.wrap(function *(repo, subs, url, exclude) {
    const fetcher = co.wrap(function *(name) {

        // If this submodule is excluded, skip it.

        if (null !== exclude && null !== exclude.exec(name)) {
            return;                                                   // RETURN
        }
        const sub = subs[name];
        const subUrl = SubmoduleConfigUtil.resolveSubmoduleUrl(url, sub.url);
        try {
            yield GitUtil.fetchSha(repo, subUrl, sub.sha);
        }
        catch (e) {
        }
    });
    yield DoWorkQueue.doInParallel(Object.keys(subs), fetcher, 100);
});

const stitch = co.wrap(function *(repoPath,
                                  commitish,
                                  url,
                                  preFetchSubs,
                                  exclude,
                                  detach) {
    const repo = yield NodeGit.Repository.open(repoPath);
    const annotated = yield GitUtil.resolveCommitish(repo, commitish);
    if (null === annotated) {
        throw new Error(`Could not resolve ${commitish}.`);
    }
    const commit = yield repo.getCommit(annotated.id());
    const todo = [commit];
    const commitSubmodules = {};
    const rootSubs = yield getCommitSubmodules(repo, commit, commitSubmodules);
    if (preFetchSubs) {
        console.log("Pre-fetching");
        yield preFetch(repo, rootSubs, url, exclude);
        console.log("Finished pre-fetching");
    }
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
                                                    commitSubmodules,
                                                    url,
                                                    exclude,
                                                    detach);
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
        const exclude = (null === args.exclude) ?
            null :
            new RegExp(args.exclude);
        yield stitch(args.repo,
                     args.commitish,
                     args.url,
                     args.pre_fetch,
                     exclude,
                     args.discard);
    }
    catch (e) {
        console.error(e.stack);
    }
});
