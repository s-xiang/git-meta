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
const co             = require("co");
const rimraf         = require("rimraf");

const RepoAST             = require("./util/repo_ast");
const Stopwatch           = require("./util/stopwatch");
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
    required: true,
    type: "int",
    help: "number of meta-repo commits to generate",
});

const args = parser.parseArgs();

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


class Commit {
    constructor(id, changes) {
        this.id = id;
        this.changes = changes;
    }
}

class State {
    constructor() {
        this.submoduleNames   = [];     // paths of all subs
        this.submoduleCommits = {};     // map to array of commits
        this.metaCommits      = [];     // array of commits
        this.nextCommitId     = 2;
    }

    generateCommitId() {
        return "" + this.nextCommitId++;
    }
}

function changeSubmodule(state, name) {
    let commits = state.submoduleCommits[name];
    if (undefined === commits) {
        commits = [];
        state.submoduleCommits[name] = commits;
    }
    const numCommits = randomInt(3) + 1;
    let newHead = null;
    for (let i = 0; i < numCommits; ++i) {
        newHead = state.generateCommitId();
        let changes = {};

        // If this subrepo already has changes, we'll go back and update a few
        // of them at random.

        if (0 !== commits.length) {
            const numChanges = randomInt(4) + 1;
            for (let j = 0; j < numChanges; ++j) {
                const commitToUpdate = commits[randomInt(commits.length)];
                for (let path in commitToUpdate.changes) {
                    changes[path] = state.nextCommitId + generateCharacter();
                }
            }
        }
        // Add a path if there are no commits yet, or on a 1/3 chance
        if (0 === commits.length || 0 === randomInt(3)) {
            const path = generatePath(randomInt(7) + 1);
            changes[path] = state.nextCommitId + generateCharacter();
        }
        commits.push(new Commit(newHead, changes));
    }
    return newHead;
}

function makeMetaCommit(state) {
    const subsToChange = randomInt(3) + 1;
    let subPaths = {};
    const numSubs = state.submoduleNames.length;

    if (0 !== numSubs) {
        // randomly pick subs to modify

        for (let i = 0; i < subsToChange; ++i) {
            const index = randomInt(numSubs);
            const name = state.submoduleNames[index];
            if (!(name in subPaths)) {
                subPaths[name] = true;
            }
        }
    }

    // one commit in five add a sub or always if no subs

    if (0 === numSubs || 0 === randomInt(5)) {
        while (true) {
            const path = generatePath(3);
            if (!(path in state.submoduleCommits)) {
                subPaths[path] = true;
                state.submoduleNames.push(path);
                break;
            }
        }
    }

    let subCommits = {};
    Object.keys(subPaths).forEach(function (path) {
        const newHead = changeSubmodule(state, path);
        subCommits[path] = newHead;
    });
    const commitId = state.generateCommitId();
    state.metaCommits.push(new Commit(commitId, subCommits));
}

function renderMetaCommits(state) {
    const result = {};
    const theFirst = "the-first";
    result[theFirst] = new RepoAST.Commit({
        parents: [],
        message: "I am the first commit.",
        changes: { "README.md": "# Hello World" },
    });
    let lastCommit = theFirst;
    for (let i = 0; i < state.metaCommits.length; ++i) {
        const metaCommit = state.metaCommits[i];
        const metaChanges = metaCommit.changes;
        const changes = {};
        for (let path in metaChanges) {
            changes[path] = new RepoAST.Submodule(".", metaChanges[path]);
        }
        const commit = new RepoAST.Commit({
            parents: [lastCommit],
            message: `commit ${metaCommit.id}`,
            changes: changes,
        });
        result[metaCommit.id] = commit;
        lastCommit = metaCommit.id;
    }
    return result;
}

function renderSubCommits(state) {
    const result = {};
    for (let path in state.submoduleCommits) {
        const subCommits = state.submoduleCommits[path];
        let lastCommit = null;
        for (let i = 0; i < subCommits.length; ++i) {
            const commit = subCommits[i];
            result[commit.id] = new RepoAST.Commit({
                parents: lastCommit === null ? [] : [lastCommit],
                changes: commit.changes,
                message: `${commit.id} commit to ${path}`,
            });
            lastCommit = commit.id;
        }
    }
    return result;
}

function renderRefs(state) {
    const result = {};
    for (let path in state.submoduleCommits) {
        const commits = state.submoduleCommits[path];
        const last = commits[commits.length - 1];
        result[`commits/${last.id}`] = `${last.id}`;
    }
    return result;
}

function renderState(state) {
    // Short-ciruit for base-case.

    let commits = {};
    const timer = new Stopwatch();
    process.stdout.write(`Rendering meta commits... `);
    Object.assign(commits, renderMetaCommits(state));
    process.stdout.write(`took ${timer.reset()} seconds.\n`);
    process.stdout.write(`Rendering sub commits... `);
    Object.assign(commits, renderSubCommits(state));
    process.stdout.write(`took ${timer.reset()} seconds.\n`);
    process.stdout.write(`Rendering refs... `);
    const refs = renderRefs(state);
    process.stdout.write(`took ${timer.reset()} seconds.\n`);
    const lastCommit = state.metaCommits[state.metaCommits.length - 1];
    process.stdout.write(`Making AST... `);
    const result = new RepoAST({
        commits: commits,
        refs: refs,
        branches: { master: lastCommit.id },
        raw: true,
    });
    process.stdout.write(`took ${timer.elapsed}.\n`);
    return result;
}

function printSummary(state) {
    let totalSubCommits = 0;
    let totalChanges = 0;
    Object.keys(state.submoduleCommits).forEach(name => {
        const commits = state.submoduleCommits[name];
        totalSubCommits += commits.length;
        for (let i = 0; i < commits.length; ++i) {
            totalChanges += Object.keys(commits[i]).length;
        }
    });
    console.log(`Going to write ${state.metaCommits.length} meta commits, \
${state.submoduleNames.length} submodules, ${totalSubCommits} submodule \
commits, and ${totalChanges} changes.`);
}

co(function *() {
    try {
        const time = new Stopwatch(true);
        process.stdout.write("Generating state... ");
        const state = new State();
        for (let i = 0; i < args.count; ++i) {
            makeMetaCommit(state);
        }
        process.stdout.write(`took ${time.elapsed}.\n`);
        printSummary(state);
        const ast = renderState(state);
        time.reset();
        if (args.overwrite) {
            process.stdout.write("Removing old files... ");
            yield (new Promise(callback => {
                return rimraf(args.destination, {}, callback);
            }));
            process.stdout.write(`took ${time.reset()} seconds.\n`);
        }
        console.log("Writing AST...");
        yield WriteRepoASTUtil.writeRAST(ast, args.destination);
        console.log(`Writing AST took ${time.elapsed} seconds.`);
    }
    catch(e) {
        console.error(e.stack);
    }
});
