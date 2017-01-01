#!/usr/bin/env node
/*
 * Copyright (c) 2016, Two Sigma Open Source
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

const ArgumentParser = require("argparse").ArgumentParser;
const assert         = require("chai").assert;
const co             = require("co");
const fs             = require("fs-promise");
const NodeGit        = require("nodegit");
const path           = require("path");
const rimraf         = require("rimraf");

const GitUtil             = require("./util/git_util");
const RepoAST             = require("./util/repo_ast");
const Stopwatch           = require("./util/stopwatch");
const TestUtil            = require("./util/test_util");
const SyntheticBranchUtil = require("./util/synthetic_branch_util");
const WriteRepoASTUtil    = require("./util/write_repo_ast_util");

const description = `Write the repos described by a string having the syntax \
described in ./util/shorthand_parser_util.`;

const parser = new ArgumentParser({
    addHelp: true,
    description: description
});

parser.addArgument(["destination"], {
    type: "string",
    help: "directory to create repository in",
});

parser.addArgument(["-o", "--overwrite"], {
    required: false,
    action: "storeConst",
    constant: true,
    help: `automatically remove existing directories`,
});

parser.addArgument(["-c", "--count"], {
    required: false,
    defaultValue: -1,
    type: "int",
    help: "number of meta-repo commit block iterations, omit to go forever",
});

parser.addArgument(["-b", "--block-size"], {
    required: false,
    defaultValue: 100,
    type: "int",
    help: "number of commits to write at once",
});

const args = parser.parseArgs();

// From repository.h

const BARE   = 1 << 0;
const MKPATH = 1 << 4;

/**
 * Return a random integer in the range of [0, max).
 * 
 * @param {Number} max
 * @return {Number}
 */
function randomInt(max) {
    return Math.floor(Math.random() * max);
}

const baseChar = "a".charCodeAt(0);

function generateCharacter() {
    return String.fromCharCode(baseChar + randomInt(26));
}

function generatePath(depth) {
    let result = "";
    for (let i = 0; i < depth; ++i) {
        if (0 !== i) {
            result += "/";
        }
        result += (generateCharacter() + generateCharacter());
    }
    // Make leaves have three characters so they're always distinct from
    // directories.

    return result + generateCharacter();
}

class Submodule {
    constructor() {
        this.renderCache = {};  // accumulated changes per commit
        this.commits = {};      // logical sha to commit
        this.repo    = null;    // NodeGit.Repository, setup in `getRepo`
        this.head    = null;    // current head

        this.newShas         = [];  // shas created in latest batch
        this.referencedHeads = [];  // referenced in most recent meta commits
    }
}

Submodule.prototype.getRepo = co.wrap(function *(origin, tempDir, name) {
    assert.isString(origin);
    assert.isString(tempDir);
    assert.isString(name);

    if (null !== this.repo) {
        return this.repo;
    }

    const dir = path.join(tempDir, name);

    this.repo = yield NodeGit.Repository.initExt(dir, {
        originUrl: origin,
        flags: BARE | MKPATH,
        bare: 1,
    });
    return this.repo;
});

class State {
    constructor() {
        this.tempDir          = null;       // root temp directory
        this.subsDir          = null;       // where sub repos live
        this.renderCache      = {};         // used in writing commits
        this.oldCommitMap     = {};         // maps logical to physical sha
        this.metaCommits      = {};         // logical sha to RepoAST.Commit
        this.submoduleNames   = [];         // paths of all subs
        this.submodules       = {};         // name to `Submodule` object
        this.metaRepo         = null;       // where meta commits are made
        this.mongoRepo        = null;       // the repo with all commits
        this.metaHead         = null;       // array of shas
        this.newMetaShas      = [];         // shas in latet block
        this.updatedSubs      = new Set();  // names of subs changed in block
        this.nextCommitId     = 0;
    }

    generateCommitId() {
        return "" + this.nextCommitId++;
    }
}

State.create = co.wrap(function *(targetDir) {
    assert.isString(targetDir);

    const res = new State();
    res.tempDir = yield TestUtil.makeTempDir();
    res.subsDir = path.join(res.tempDir, "subs");
    yield fs.mkdir(res.subsDir);

    res.mongoRepo = yield NodeGit.Repository.initExt(targetDir, {
        flags: BARE | MKPATH,
        bare: 1,
    });

    const metaDir = path.join(res.tempDir, "meta");
    res.metaRepo = yield NodeGit.Repository.initExt(metaDir, {
        originUrl: res.mongoRepo.path(),
        flags: BARE | MKPATH,
        bare: 1,
    });

    return res;
});

function makeSubCommits(state, name) {
    let sub = state.submodules[name];
    if (undefined === sub) {
        sub = new Submodule();
        state.submodules[name] = sub;
    }
    const numCommits = randomInt(3) + 1;
    for (let i = 0; i < numCommits; ++i) {
        const newHead = state.generateCommitId();
        let changes = {};

        // If this subrepo already has changes, we'll go back and update a few
        // of them at random.

        if (null !== sub.head) {
            const oldChanges = RepoAST.renderCommit(sub.renderCache,
                                                    sub.commits,
                                                    sub.head);
            const paths = Object.keys(oldChanges);
            const numChanges = randomInt(4) + 1;
            for (let j = 0; j < numChanges; ++j) {
                const pathToUpdate = paths[randomInt(paths.length)];
                changes[pathToUpdate] =
                                      state.nextCommitId + generateCharacter();
            }
        }

        // Add a path if there are no commits yet, or on a 1/3 chance

        if (null === sub.head || 0 === randomInt(3)) {
            const path = generatePath(randomInt(7) + 1);
            changes[path] = state.nextCommitId + generateCharacter();
        }
        const parents = null === sub.head ? [] : [sub.head];
        sub.head = newHead;
        sub.newShas.push(newHead);
        const commit = new RepoAST.Commit({
            parents: parents,
            changes: changes,
            message: `a random commit for sub ${name}, #${newHead}`,
        });

        sub.commits[newHead] = commit;
    }

    // The last head generated will be referenced by a meta commit; remembrer
    // it so that we will generate a ref for it later.

    sub.referencedHeads.push(sub.head);
    return sub.head;
}

/**
 * Generate commits in the specified `state`.
 *
 * @param {State}     state
 */
function makeMetaCommit(state) {
    const subsToChange = randomInt(3) + 1;
    const subPaths = new Set();
    const numSubs = state.submoduleNames.length;

    if (0 !== numSubs) {
        // randomly pick subs to modify

        for (let i = 0; i < subsToChange; ++i) {
            const index = randomInt(numSubs);
            const name = state.submoduleNames[index];
            if (!(name in subPaths)) {
                subPaths.add(name);
            }
        }
    }

    // one commit in five add a sub or always if no subs

    if (0 === numSubs || 0 === randomInt(5)) {
        while (true) {
            const path = generatePath(3);
            if (!(path in state.submodules)) {
                subPaths.add(path);
                state.submoduleNames.push(path);
                break;
            }
        }
    }

    const changes = {};
    subPaths.forEach(function (path) {
        const newHead = makeSubCommits(state, path);
        changes[path] = new RepoAST.Submodule(".", newHead);
        state.updatedSubs.add(path);
    });
    const commitId = state.generateCommitId();
    const lastHead = state.metaHead;
    state.metaHead = commitId;
    const parents = lastHead === null ? [] : [lastHead];
    const commit = new RepoAST.Commit({
        parents: parents,
        changes: changes,
        message: `a friendly meta commit, #${commitId}`,
    });
    state.metaCommits[commitId] = commit;
    state.newMetaShas.push(commitId);
}

const renderBlock = co.wrap(function *(state) {
    let totalCommits = 0;
    console.log("#", Array.from(state.updatedSubs).length);
    const timer = new Stopwatch();
    yield Array.from(state.updatedSubs).map(co.wrap(function *(subName) {
        const sub = state.submodules[subName];
        totalCommits += sub.newShas.length;
        const subRepo = yield sub.getRepo(state.mongoRepo.path(),
                                          state.subsDir,
                                          subName);
        yield WriteRepoASTUtil.writeCommits(state.oldCommitMap,
                                            sub.renderCache,
                                            subRepo,
                                            sub.commits,
                                            sub.newShas);
        sub.newShas = [];

        // Move 'master' to point to the new head to anchor commits.

        const newHeadSha = state.oldCommitMap[sub.head];
        yield NodeGit.Reference.create(subRepo,
                                       "refs/heads/master",
                                       newHeadSha,
                                       1,
                                       "m");

        // Push meta-refs

        yield sub.referencedHeads.map(co.wrap(logicalSha=> {
            const sha = state.oldCommitMap[logicalSha];
            const name = SyntheticBranchUtil.getSyntheticBranchForCommit(sha);
            return GitUtil.push(subRepo, "origin", sha, name, false, true);
        }));
        sub.referencedHeads = [];
    }));
    console.log("SUBS TOOK:", timer.elapsed);
    state.updatedSubs = new Set();
    yield WriteRepoASTUtil.writeCommits(state.oldCommitMap,
                                        state.renderCache,
                                        state.metaRepo,
                                        state.metaCommits,
                                        state.newMetaShas);
    totalCommits += state.newMetaShas.length;
    state.newMetaShas = [];
    const headId = state.oldCommitMap[state.metaHead];
    yield NodeGit.Reference.create(state.metaRepo,
                                   "refs/heads/master",
                                   headId,
                                   1,
                                   "meta master");
    yield GitUtil.push(state.metaRepo,
                       "origin",
                       headId,
                       "master",
                       false,
                       true);
    return totalCommits;
});

co(function *() {
    try {
        const path = args.destination;
        if (args.overwrite) {
            const timer = new Stopwatch();
            process.stdout.write("Removing old files... ");
            yield (new Promise(callback => {
                return rimraf(path, {}, callback);
            }));
            process.stdout.write(`took ${timer.elapsed} seconds.\n`);
        }
        const totalTime = new Stopwatch();
        const count = args.count;
        const blockSize = args.block_size;
        const state = yield State.create(path);
        console.log(`Generating ${count < 0 ? "infinite" : count} blocks of \
${blockSize} commits.`);
        let totalMetaCommits = 0;
        let totalCommits = 0;
        for (let i = 0; -1 === count || i < count; ++i) {
            for (let i = 0; i < blockSize; ++i) {
                makeMetaCommit(state);
            }
            const count = yield renderBlock(state);
            totalMetaCommits += args.block_size;
            totalCommits += count;
            console.log(`Written ${totalMetaCommits} meta commits at rate of \
${totalMetaCommits / totalTime.elapsed}/S, ${totalCommits} commits at rate of \
${totalCommits / totalTime.elapsed}/S, total elapsed: ${totalTime.elapsed}.`);
        }
    }
    catch(e) {
        console.error(e.stack);
    }
});
