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

const DoWorkQueue         = require("./util/do_work_queue");
const GitUtil             = require("./util/git_util");
const StitchUtil          = require("./util/stitch_util");

const description = `Stitch together the specified meta-repo commitish in \
the specified repo.`;

const parser = new ArgumentParser({
    addHelp: true,
    description: description
});

parser.addArgument(["--no-fetch"], {
    required: false,
    action: "storeConst",
    constant: true,
    defaultValue: false,
    help: `If provided, assume commits are present and do not fetch.`,
});

parser.addArgument(["-t", "--target-branch"], {
    required: false,
    type: "string",
    defaultValue: "master",
    help: "Branch to update with committed ref; default is 'master'.",
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
    help: "number of parallel operations, default 8",
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

const stitch = co.wrap(function *(repoPath,
                                  commitish,
                                  url,
                                  exclude,
                                  detach,
                                  numParallel,
                                  fetch,
                                  targetBranchName) {
    const repo = yield NodeGit.Repository.open(repoPath);
    const annotated = yield GitUtil.resolveCommitish(repo, commitish);
    if (null === annotated) {
        throw new Error(`Could not resolve ${commitish}.`);
    }
    const commit = yield repo.getCommit(annotated.id());

    console.log("listing unconverted ancestors of", commit.id().tostrS());

    const commitsToStitch = yield StitchUtil.listCommitsToStitch(repo, commit);

    console.log(commitsToStitch.length, "to stitch");

    if (fetch) {
        console.log("listing fetches");
        const fetches = yield StitchUtil.listFetches(repo,
                                                     commitsToStitch,
                                                     exclude,
                                                     numParallel);
        console.log("Found", Object.keys(fetches).length, "subs to fetch.");
        const subNames = Object.keys(fetches);
        const doFetch = co.wrap(function *(name, i) {
            const subFetches = fetches[name];
            const fetchTimeMessage = `\
(${i + 1}/${subNames.length}) -- fetched ${subFetches.length} SHAs for \
${name}`;
            console.time(fetchTimeMessage);
            yield StitchUtil.fetchSubCommits(repo, url, subFetches);
            console.timeEnd(fetchTimeMessage);
        });
        yield DoWorkQueue.doInParallel(subNames, doFetch, numParallel);
    }

    console.log("Now stitching");
    let lastCommit;

    for (let i = 0; i < commitsToStitch.length; ++i) {
        const next = commitsToStitch[i];

        // If we had the same commit in the graph more than once, don't convert
        // it more than once.

        const nextSha = next.id().tostrS();
        const parents = yield next.getParents();
        const newParents = [];
        for (let i = 0; i < parents.length; ++i) {
            const parent = parents[i];
            const newParentSha =
                  yield StitchUtil.getConvertedSha(repo, parent.id().tostrS());
            const newParent = yield repo.getCommit(newParentSha);
            newParents.push(newParent);
        }

        const newCommit = yield StitchUtil.writeStitchedCommit(repo,
                                                               next,
                                                               newParents,
                                                               exclude,
                                                               detach);
        const log = `\
${nextSha} -> ${newCommit.id().tostrS()} [${i}] \
[${commitsToStitch.length}] to go in queue.`;
            console.log(log);
        lastCommit = newCommit;
    }
    if (undefined !== lastCommit) {
        console.log(
               `Updating ${targetBranchName} to ${lastCommit.id().tostrS()}.`);
        yield NodeGit.Branch.create(repo, targetBranchName, lastCommit, 1);
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
                     args.j,
                     !args.no_fetch,
                     args.target_branch);
    }
    catch (e) {
        console.error(e.stack);
    }
});
