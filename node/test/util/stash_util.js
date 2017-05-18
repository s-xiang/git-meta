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
"use strict";

const assert  = require("chai").assert;
const co      = require("co");
const NodeGit = require("nodegit");

const StashUtil       = require("../../lib/util/stash_util");
const StatusUtil      = require("../../lib/util/status_util");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");

/**
 * Replace all the submodule stash refs in the form of `sub-stash/ss` with
 * `sub-stash/${physical id}`, where  'physical id' refers to the id of the
 * submodule stash.
 */
function refMapper(expected, mapping) {
    const refRE  = /(sub-stash\/)(ss)/;
    const reverseCommitMap = mapping.reverseCommitMap;

    let result = {};
    Object.keys(expected).forEach(repoName => {
        const ast = expected[repoName];
        const submodules = ast.openSubmodules;
        const newSubs = {};
        Object.keys(submodules).forEach(subName => {
            const sub = submodules[subName];
            const refs = sub.refs;
            const newRefs = {};
            Object.keys(refs).forEach(refName => {
                const logicalId = refs[refName];
                const physicalId = reverseCommitMap.ss;
                const newRefName = refName.replace(refRE, `$1${physicalId}`);
                newRefs[newRefName] = logicalId;
            });
            newSubs[subName] = sub.copy({
                refs: newRefs,
            });
        });
        result[repoName] = ast.copy({
            openSubmodules: newSubs,
        });
    });
    return result;
}

describe("StashUtil", function () {
    describe("stashRepo", function () {
        // We'll make a new branch, `i`, pointing to the logical commit `i`,
        // with message "i" containing the state of the index and a branch
        // named `w` pointing to the commit `w`, with the message "w"
        // contianing the state of the workdir.
        const cases = {
            "trivial": {
                input: "x=N:C1;Bmaster=1;*=master",
                expected: "x=E:Ci#i 1=1;Cw#w 1=1;Bi=i;Bw=w",
            },
            "loose file": {
                input: "x=N:C1;Bmaster=1;*=master;W foo=bar",
                expected: "x=E:Ci#i 1=1;Cw#w 1=1;Bi=i;Bw=w",
            },
            "index change": {
                input: "x=N:C1;Bmaster=1;*=master;I foo=bar",
                expected: `
x=E:Ci#i foo=bar,1=1;Cw#w foo=bar,1=1;Bi=i;Bw=w`,
            },
            "workdir change": {
                input: "x=N:C1;Bmaster=1;*=master;W 1=8",
                expected: `x=E:Ci#i 1=1;Cw#w 1=8;Bi=i;Bw=w`,
            },
            "workdir addition": {
                input: "x=N:C1;Bmaster=1;*=master;W foo=bar",
                expected: "x=E:Ci#i 1=1;Cw#w 1=1,foo=bar;Bi=i;Bw=w",
                all: true,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const stasher = co.wrap(function *(repos) {
                    const repo = repos.x;
                    const status = yield StatusUtil.getRepoStatus(repo);
                    const all = c.all || false;
                    const result = yield StashUtil.stashRepo(repo,
                                                             status,
                                                             all);
                    const sig = repo.defaultSignature();
                    const commitMap = {};
                    const commitAndBranch = co.wrap(function *(treeId, type) {
                        const tree = yield NodeGit.Tree.lookup(repo, treeId);
                        const commitId = yield NodeGit.Commit.create(repo,
                                                                     null,
                                                                     sig,
                                                                     sig,
                                                                     null,
                                                                     type,
                                                                     tree,
                                                                     0,
                                                                     []);
                        const commit = yield repo.getCommit(commitId);
                        yield NodeGit.Branch.create(repo, type, commit, 1);
                        commitMap[commitId.tostrS()] = type;
                    });
                    yield commitAndBranch(result.index, "i");
                    yield commitAndBranch(result.workdir, "w");
                    return {
                        commitMap: commitMap,
                    };
                });
                yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                               c.expected,
                                                               stasher,
                                                               c.fails);
            }));
        });
    });
    describe("save", function () {
        // We create stash commits based on the following scheme:
        // - s -- the stash commit
        // - i -- index commit for the stash
        // - u -- meta-commit tying subs together
        // - sN -- stash commit for submodule N
        // - siN -- stash index commit for submodule N
        // - suN -- stash for untracked files for submodule N

        const cases = {
            "trivial": {
                state: "x=N:C1;Bmaster=1;*=master",
                expected: `
x=E:Cstash#s-1,i,u ;Cindex#i 1=1;Csubmodules#u 1=1;Fmeta-stash=s`,
            },
            "minimal": {
                state: "x=S:C2-1 README.md;Bmaster=2",
                expected: `
x=E:Cstash#s-2,i,u ;Cindex#i ;Csubmodules#u ;Fmeta-stash=s`,
            },
            "closed sub": {
                state: "a=B|x=S:C2-1 README.md,s=Sa:1;Bmaster=2",
                expected: `
x=E:Cstash#s-2,i,u ;Cindex#i s=Sa:1;Csubmodules#u s=Sa:1;Fmeta-stash=s`,
            },
            "open sub": {
                state: "a=B|x=S:C2-1 README.md,s=Sa:1;Bmaster=2;Os",
                expected: `
x=E:Cstash#s-2,i,u ;Cindex#i s=Sa:1;Csubmodules#u s=Sa:1;Fmeta-stash=s`,
            },
            "open sub with an added file": {
                state: "a=B|x=S:C2-1 README.md,s=Sa:1;Bmaster=2;Os W foo=bar",
                expected: `
x=E:Cstash#s-2,i,u ;Cindex#i s=Sa:1;Csubmodules#u s=Sa:1;Fmeta-stash=s`,
            },
            "open sub with index change": {
                state: "a=B|x=S:C2-1 README.md,s=Sa:1;Bmaster=2;Os I foo=bar",
                expected: `
x=E:Fmeta-stash=s;
    Os Fsub-stash/ss=ss!
       Fstash=ss!
       C*#ss-1,sis foo=bar!
       C*#sis-1 foo=bar;
    Cstash#s-2,i,u ;
    Cindex#i s=Sa:1;
    Csubmodules#u s=Sa:ss;`,
            },
            "open sub with workdir change": {
                state: `
a=B|
x=S:C2-1 README.md,s=Sa:1;Bmaster=2;Os W README.md=meh`,
                expected: `
x=E:Fmeta-stash=s;
    Os Fsub-stash/ss=ss!
       Fstash=ss!
       C*#ss-1,sis README.md=meh!
       C*#sis-1 ;
    Cstash#s-2,i,u ;
    Cindex#i s=Sa:1;
    Csubmodules#u s=Sa:ss;`,
            },
            "open sub with index and workdir change": {
                state: `
a=B|
x=S:C2-1 README.md,s=Sa:1;Bmaster=2;Os W README.md=meh!I foo=bar`,
                expected: `
x=E:Fmeta-stash=s;
    Os Fsub-stash/ss=ss!
       Fstash=ss!
       C*#ss-1,sis README.md=meh,foo=bar!
       C*#sis-1 foo=bar;
    Cstash#s-2,i,u ;
    Cindex#i s=Sa:1;
    Csubmodules#u s=Sa:ss;`,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            const all = c.all || false;
            const stasher = co.wrap(function *(repos) {
                const repo = repos.x;
                const status = yield StatusUtil.getRepoStatus(repo, {
                    showMetaChanges: false,
                });
                const result = yield StashUtil.save(repo, status, all);
                const commitMap = {};
                commitMap[result.workdirSha] = "s";
                commitMap[result.indexSha] = "i";
                commitMap[result.submodulesSha] = "u";
                const subs = result.submodules;
                Object.keys(subs).forEach(name => {
                    const sub = subs[name];
                    commitMap[sub.indexSha] = `si${name}`;
                    if (null !== sub.untrackedSha) {
                        commitMap[sub.untrackedSha] = `su${name}`;
                    }
                    commitMap[sub.workdirSha] = `s${name}`;
                });
                return {
                    commitMap: commitMap,
                };
            });
            it(caseName, co.wrap(function *() {
                yield RepoASTTestUtil.testMultiRepoManipulator(c.state,
                                                               c.expected,
                                                               stasher,
                                                               c.fails, {
                    expectedTransformer: refMapper,
                });
            }));
        });
        it("open sub with an added file and all", co.wrap(function *() {
            // TODO: Going to do a sanity check on 'all'.  Something about the
            // way Git writes this commit breaks my test framework (it looksl
            // ike a commit is deleting a file that doesn't exist in the stash
            // commit); I don't know that it's worth diagnosing right now since
            // I really just need to know that the 'all' flag is passed through
            // properly.

            const state =
                        "a=B|x=S:C2-1 README.md,s=Sa:1;Bmaster=2;Os W foo=bar";
            const w = yield RepoASTTestUtil.createMultiRepos(state);
            const repo = w.repos.x;
            const status = yield StatusUtil.getRepoStatus(repo, {
                showMetaChanges: false,
            });
            const result = yield StashUtil.save(repo, status, true);
            assert.isNotNull(result.submodules.s.untrackedSha);
        }));
    });
});
