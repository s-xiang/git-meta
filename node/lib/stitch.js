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
const assert         = require("chai").assert;
const co             = require("co");
const NodeGit        = require("nodegit");
const FILEMODE       = NodeGit.TreeEntry.FILEMODE;

const Commit              = require("./util/commit");
const DoWorkQueue         = require("./util/do_work_queue");
const GitUtil             = require("./util/git_util");
const StitchUtil          = require("./util/stitch_util");
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

parser.addArgument(["-j"], {
    required: false,
    type: "int",
    help: "number of parallel fetches, default 8",
    defaultValue: 8,
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

const fetchCommits = co.wrap(function *(repo,
                                        toFetch,
                                        url,
                                        exclude,
                                        numParallel) {
    console.log("Listing pre-fetches from:", toFetch.length, "commits.");

    const todo = [];
    let urls = {};

    if (0 !== toFetch.length) {
        urls =
           yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, toFetch[0]);
    }

    // So that we don't have to continuously re-read the `.gitmodules` file, we
    // will assume that submodule URLs never change.

    const getUrl = co.wrap(function *(commit, sub) {
        let subUrl = urls[sub];

        // If we don't have the url for this submodule, load them.

        if (undefined === subUrl) {
            console.log("loading urls");
            const newUrls =
               yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, commit);
            urls = Object.assign(urls, newUrls);
            subUrl = urls[sub];
        }
        return url;
    });

    const listCommitFetches = co.wrap(function *(commit, i) {
        if (1 === i % 10) {
            console.log(i, "/", toFetch.length);
            console.log("TODO size:", todo.length);
        }
        const changes = yield SubmoduleUtil.getSubmoduleChanges(repo, commit);

        // look for added submodules

        const added = changes.added;
        for (let name in added) {
            if (!exclude(name)) {
                const subUrl = yield getUrl(commit, name);
                todo.push({
                    url: subUrl,
                    sha: added[name],
                });
            }
        }

        // or changed submodules

        const changed = changes.changed;
        for (let name in changed) {
            if (!exclude(name)) {
                const subUrl = yield getUrl(commit, name);
                todo.push({
                    url: subUrl,
                    sha: changed[name]["new"],
                });
            }
        }
    });

    yield DoWorkQueue.doInParallel(toFetch, listCommitFetches, numParallel);

    const fetcher = co.wrap(function *(entry) {
        const url = entry.url;
        const sha = entry.sha;

        try {
            yield GitUtil.fetchSha(repo, url, sha);
        }
        catch (e) {
            return;                                                   // RETURN
        }
        const refName =
                      SyntheticBranchUtil.getSyntheticBranchForCommit(sha);
        yield NodeGit.Reference.create(repo,
                                       refName,
                                       sha,
                                       1,
                                       "synthetic ref");
    });

    if (0 !== todo.length) {
        console.log("# potential fetches:", todo.length);
    }

    yield DoWorkQueue.doInParallel(todo, fetcher, numParallel);
});

const stitch = co.wrap(function *(repoPath,
                                  commitish,
                                  url,
                                  exclude,
                                  detach,
                                  numParallel) {
    const repo = yield NodeGit.Repository.open(repoPath);
    const annotated = yield GitUtil.resolveCommitish(repo, commitish);
    if (null === annotated) {
        throw new Error(`Could not resolve ${commitish}.`);
    }
    const commit = yield repo.getCommit(annotated.id());

    const todo = [commit];

    // As we find commits we will duplicate the todo list here.  We'll
    // pre-fetch all the possible submodules associated with these commits in
    // the order we found them to minimize the number of actual fetches needed.

    let toFetch = [commit];
    const cachedChanges = {};
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
                toFetch.push(parent);
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
            yield fetchCommits(repo,
                               toFetch,
                               url,
                               cachedChanges,
                               exclude,
                               numParallel);
            toFetch = [];
            const newCommit = yield writeMetaCommit(repo,
                                                    next,
                                                    newParents,
                                                    cachedChanges,
                                                    url,
                                                    exclude,
                                                    detach);
            console.log(nextSha, "->", newCommit.id().tostrS());
            todo.pop();
        }
    }
});

co(function *() {
    const args = parser.parseArgs();
    const excludeRegex = (null === args.exclude) ?
        null :
        new RegExp(args.exclude);
    function exclude(name) {
        return null !== excludeRegex && null !== excludeRegex.exec(name);
    }
    try {
        yield stitch(args.repo,
                     args.commitish,
                     args.url,
                     exclude,
                     args.discard,
                     args.j);
    }
    catch (e) {
        console.error(e.stack);
    }
});
