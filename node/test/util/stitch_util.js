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

const Commit              = require("../../lib/util/commit");
//const GitUtil           = require("../../lib/util/git_util");
const RepoAST             = require("../../lib/util/repo_ast");
const RepoASTTestUtil     = require("../../lib/util/repo_ast_test_util");
const RepoASTUtil         = require("../../lib/util/repo_ast_util");
const StitchUtil          = require("../../lib/util/stitch_util");
//const StatusUtil      = require("../../lib/util/status_util");
//const SubmoduleUtil   = require("../../lib/util/submodule_util");
const SubmoduleConfigUtil = require("../../lib/util/submodule_config_util");
const TreeUtil            = require("../../lib/util/tree_util");

const FILEMODE            = NodeGit.TreeEntry.FILEMODE;

function deSplitSha(sha) {
    return sha.slice(0, 2) + sha.slice(3);
}

/**
 *  - Replace `refs/stitched/converted/${splitSha(sha)}}` refs with their
 *    equivalent logical mapping, e.g., if logical commit "1" maps to "aabb",
 *    then we will remap `refs/stitched/converted/aa/bb` to
 *    `refs/stitched/converted/1`.
 */
function refMapper(actual, mapping) {
    const convertedRe = /(stitched\/converted\/)(.*)/;
    const fetchedSubRe = /(stitched\/fetched\/)(.*)(\/sub\/)(.*)/;
    const commitMap = mapping.commitMap;
    let result = {};
    Object.keys(actual).forEach(repoName => {
        const ast = actual[repoName];
        const refs = ast.refs;
        const newRefs = {};
        Object.keys(refs).forEach(refName => {
            const ref = refs[refName];
            const convertedMatch = convertedRe.exec(refName);
            if (null !== convertedMatch) {
                const physical = deSplitSha(convertedMatch[2]);
                const logical = commitMap[physical];
                const newRefName = refName.replace(convertedRe,
                                                   `$1${logical}`);
                newRefs[newRefName] = ref;
                return;                                               // RETURN
            }
            const fetchedSubMatch = fetchedSubRe.exec(refName);
            if (null !== fetchedSubMatch) {
                const metaPhys = deSplitSha(fetchedSubMatch[2]);
                const metaLog = commitMap[metaPhys];
                const subPhys = deSplitSha(fetchedSubMatch[4]);
                const subLog = commitMap[subPhys];
                const newRefName = refName.replace(fetchedSubRe,
                                                   `$1${metaLog}$3${subLog}`);
                newRefs[newRefName] = ref;
                return;                                               // RETURN
            }
            newRefs[refName] = ref;
        });
        result[repoName] = ast.copy({
            refs: newRefs,
        });
    });
    return result;
}

describe("StitchUtil", function () {
    describe("listCommitsInOrder", function () {
        const cases = {
            "trival": {
                input: {
                    a: [],
                },
                entry: "a",
                expected: ["a"],
            },
            "skipped entry": {
                input: {},
                entry: "a",
                expected: [],
            },
            "one parent": {
                input: {
                    a: ["b"],
                    b: [],
                },
                entry: "a",
                expected: ["b", "a"],
            },
            "one parent, skipped": {
                input: {
                    b: [],
                },
                entry: "b",
                expected: ["b"],
            },
            "two parents": {
                input: {
                    b: ["a", "c"],
                    a: [],
                    c: [],
                },
                entry: "b",
                expected: ["a", "c", "b"],
            },
            "chain": {
                input: {
                    a: ["b"],
                    b: ["c"],
                    c: [],
                },
                entry: "a",
                expected: ["c", "b", "a"],
            },
            "reference the same commit twice in history": {
                input: {
                    c: ["b"],
                    a: ["b"],
                    d: ["a", "c"],
                    b: ["e", "f"],
                    e: ["f"],
                    f: [],
                },
                entry: "d",
                expected: ["f", "e", "b", "a", "c", "d"],
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = StitchUtil.listCommitsInOrder(c.entry, c.input);
                assert.deepEqual(c.expected, result);
            });
        });
    });
    describe("listCommitsToStitch", function () {
        // We don't need to validate the ordering part; that is check in the
        // test driver for 'listCommitsInOrder'.  We need to validate basic
        // functionality, and that we stop at previously converted commits.

        it("trivial", co.wrap(function *() {
            const written = yield RepoASTTestUtil.createRepo("S");
            const repo = written.repo;
            const head = yield repo.getHeadCommit();
            const result = yield StitchUtil.listCommitsToStitch(repo, head);
            const headSha = head.id().tostrS();
            const resultShas = result.map(c => c.id().tostrS());
            assert.deepEqual([headSha], resultShas);
        }));

        it("skipped", co.wrap(function *() {
            const written = yield RepoASTTestUtil.createRepo("S");
            const repo = written.repo;
            const head = yield repo.getHeadCommit();
            const headSha = head.id().tostrS();
            const convertedRef = StitchUtil.convertedRefName(headSha);
            yield NodeGit.Reference.create(repo,
                                           convertedRef,
                                           headSha,
                                           1,
                                           "mark");
            const result = yield StitchUtil.listCommitsToStitch(repo, head);
            const resultShas = result.map(c => c.id().tostrS());
            assert.deepEqual([], resultShas);
        }));

        it("with parents", co.wrap(function *() {
            const written = yield RepoASTTestUtil.createRepo(
                                        "S:C3-2,4;C4-2;C2-1;C5-3,4;Bmaster=5");
            const repo = written.repo;
            const head = yield repo.getHeadCommit();
            const result = yield StitchUtil.listCommitsToStitch(repo, head);
            const expected = ["1", "2", "4", "3", "5"];
            const resultShas = result.map(c => {
                const sha = c.id().tostrS();
                return written.commitMap[sha];
            });
            assert.deepEqual(expected, resultShas);
        }));

        it("with parents and marker", co.wrap(function *() {
            const written = yield RepoASTTestUtil.createRepo(
                                        "S:C3-2,4;C4-2;C2-1;C5-3,4;Bmaster=5");
            const repo = written.repo;
            const head = yield repo.getHeadCommit();
            const twoSha = written.oldCommitMap["2"];
            const convertedRef = StitchUtil.convertedRefName(twoSha);
            yield NodeGit.Reference.create(repo,
                                           convertedRef,
                                           twoSha,
                                           1,
                                           "mark");
            const result = yield StitchUtil.listCommitsToStitch(repo, head);
            const expected = ["4", "3", "5"];
            const resultShas = result.map(c => {
                const sha = c.id().tostrS();
                return written.commitMap[sha];
            });
            assert.deepEqual(expected, resultShas);
        }));
    });
    it("deSplitSha", function () {
        assert.equal("1234", deSplitSha("12/34"));
    });
    describe("refMapper", function () {
        const Commit    = RepoAST.Commit;
        const cases = {
            "trivial": {
                input: {
                },
                expected: {
                },
            },
            "simple": {
                input: {
                    x: new RepoAST(),
                },
                expected: {
                    x: new RepoAST(),
                },
            },
            "no transform": {
                input: {
                    x: new RepoAST({
                        commits: { "1": new Commit() },
                        refs: {
                            "foo/bar": "1",
                        },
                    }),
                },
                expected: {
                    x: new RepoAST({
                        commits: { "1": new Commit() },
                        refs: {
                            "foo/bar": "1",
                        },
                    }),
                },
            },
            "converted": {
                input: {
                    x: new RepoAST({
                        commits: {
                            "fffd": new Commit(),
                        },
                        refs: {
                            "stitched/converted/ff/ff": "fffd",
                        },
                    }),
                },
                expected: {
                    x: new RepoAST({
                        commits: {
                            "fffd": new Commit(),
                        },
                        refs: {
                            "stitched/converted/1": "fffd",
                        },
                    }),
                },
                commitMap: {
                    "ffff": "1",
                },
            },
            "fetched sub": {
                input: {
                    x: new RepoAST({
                        commits: {
                            "fffd": new Commit(),
                        },
                        refs: {
                            "stitched/fetched/ff/ff/sub/aa/bb": "fffd",
                        },
                    }),
                },
                expected: {
                    x: new RepoAST({
                        commits: {
                            "fffd": new Commit(),
                        },
                        refs: {
                            "stitched/fetched/1/sub/2": "fffd",
                        },
                    }),
                },
                commitMap: {
                    "ffff": "1",
                    "aabb": "2",
                },
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, () => {
                const result = refMapper(c.input, {
                    commitMap: c.commitMap || {},
                });
                RepoASTUtil.assertEqualRepoMaps(result, c.expected);
            });
        });

    });
    it("splitSha", function () {
        assert.equal("34/56", StitchUtil.splitSha("3456"));
    });
    it("convertedRefName", function () {
        assert.equal("refs/stitched/converted/56/78",
                     StitchUtil.convertedRefName("5678"));
    });
    it("fetchedSubRefName", function () {
        assert.equal("refs/stitched/fetched/43/556/sub/aa/ffb",
                     StitchUtil.fetchedSubRefName("43556", "aaffb"));
    });
    it("summarizeSubCommit", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const author = head.author();
        const expected =`\
Includes changes from submodule foo on ${head.id().tostrS()}.
Author: ${author.name()} <${author.email()}>
Date:   ${Commit.formatCommitTime(author.when())}

the first commit
`;
        const result = StitchUtil.summarizeSubCommit("foo", head);
        assert.deepEqual(expected.split("\n"),
                         result.split("\n"));
    }));
    describe("computeModulesFile", function () {
        const cases = {
            "one exclude": {
                newUrls: { foo: "bar/baz" },
                exclude: (name) => name === "foo",
                expected: { foo: "bar/baz" },
            },
            "one not": {
                newUrls: { foo: "bar/baz", bar: "zip/zap", },
                exclude: (name) => name === "foo",
                expected: { foo: "bar/baz" },
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written = yield RepoASTTestUtil.createRepo("S");
                const repo = written.repo;
                const text = SubmoduleConfigUtil.writeConfigText(c.expected);
                const BLOB = 3;
                const db = yield repo.odb();
                const id = yield db.write(text, text.length, BLOB);
                const result = yield StitchUtil.computeModulesFile(repo,
                                                                   c.newUrls,
                                                                   c.exclude);
                assert.instanceOf(result, TreeUtil.Change);
                assert.equal(id.tostrS(), result.id.tostrS(), "ids");
                assert.equal(FILEMODE.BLOB, result.mode, "mode");
            }));
        });
    });
    it("getConvertedSha", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S:C2-1;Ba=2");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const headSha = head.id().tostrS();
        const aRef = yield NodeGit.Reference.lookup(repo, "refs/heads/a");
        const aSha = aRef.target().tostrS();
        const convertedRef = StitchUtil.convertedRefName(headSha);

        // register the head commit as converted to the 'a' commit
        yield NodeGit.Reference.create(repo, convertedRef, aSha, 1, "ref");
        const headResult = yield StitchUtil.getConvertedSha(repo, headSha);
        assert.equal(headResult, aSha);
        const aResult = yield StitchUtil.getConvertedSha(repo, aSha);
        assert.isNull(aResult);
    }));
    describe("writeStitchedCommit", function () {
        const cases = {
            "trivial, no subs": {
                input: "x=S",
                commit: "1",
                parents: [],
                exclude: () => false,
                detatch: false,
                expected: `
x=E:Cthe first commit#s ;Fstitched/converted/1=s`,
            },
            "trivial, no subs, with a parent": {
                input: "x=S:C2;Bp=2",
                commit: "1",
                parents: ["2"],
                exclude: () => false,
                detatch: false,
                expected: `
x=E:Cthe first commit#s-2 ;Fstitched/converted/1=s`,
            },
            "new stitched sub": {
                input: `
x=B:Ca;Cfoo#2-1 s=S.:a;Ba=a;Bmaster=2`,
                commit: "2",
                parents: [],
                exclude: () => false,
                detatch: false,
                expected: `
x=E:Cfoo#s-a s/a=a,a;Fstitched/converted/2=s`,
            },
            "new stitched sub, with parent": {
                input: `
x=B:Ca;Cfoo#2-1 s=S.:a;Ba=a;Bmaster=2`,
                commit: "2",
                parents: ["1"],
                exclude: () => false,
                detatch: false,
                expected: `
x=E:Cfoo#s-1,a s/a=a;Fstitched/converted/2=s`,
            },
            "2 new stitched subs": {
                input: `
x=B:Ca;Cb;Cfoo#2-1 s=S.:a,t=S.:b;Ba=a;Bb=b;Bmaster=2`,
                commit: "2",
                parents: [],
                exclude: () => false,
                detatch: false,
                expected: `
x=E:Cfoo#s-a,b s/a=a,a,t/b=b;Fstitched/converted/2=s`,
            },
            "modified stitched": {
                input: `
x=B:Ca;Cb;Cc;Cfoo#2-1 s=S.:a,t=S.:b;C3-2 s=S.:c;Ba=a;Bb=b;Bc=c;Bmaster=3`,
                commit: "3",
                parents: [],
                exclude: () => false,
                detatch: false,
                expected: `
x=E:Cs-c s/c=c,c;Fstitched/converted/3=s`,
            },
            "removed stitched": {
                input: `
x=B:Ca;Cb;Cc s/a=b;Cfoo#2-1 s=S.:a,t=S.:b;C3-2 s;Ba=a;Bb=b;Bc=c;Bmaster=3`,
                commit: "3",
                parents: ["c"],
                exclude: () => false,
                detatch: false,
                expected: `
x=E:Cs-c s/a;Fstitched/converted/3=s`,
            },
            "excluded": {
                input: `
x=B:Ca;Cb;Cfoo#2-1 s=S.:a,t=S.:b;Ba=a;Bb=b;Bmaster=2`,
                commit: "2",
                parents: [],
                exclude: (name) => "t" === name,
                detatch: false,
                expected: `
x=E:Cfoo#s-a s/a=a,a,t=S.:b;Fstitched/converted/2=s`,
            },
            "modified excluded": {
                input: `
x=B:Ca;Cb;Ba=a;Bb=b;C2-1 s=S.:a;C3-2 s=S.:b;Cp foo=bar,s=S.:a;Bmaster=3;Bp=p`,
                commit: "3",
                parents: ["p"],
                exclude: (name) => "s" === name,
                detatch: false,
                expected: `
x=E:Cs-p s=S.:b;Fstitched/converted/3=s`,
            },
            "removed excluded": {
                input: `
x=B:Ca;Ba=a;C2-1 s=S.:a;C3-2 s;Cp foo=bar,s=S.:a;Bmaster=3;Bp=p`,
                commit: "3",
                parents: ["p"],
                exclude: (name) => "s" === name,
                detatch: false,
                expected: `
x=E:Cs-p s;Fstitched/converted/3=s`,
            },
            // We know that there aren't any real differences in the handling
            // of detatched and stitched modes other than the generation of
            // messages and parents.  We will deal with the handling of
            // messages manually, and parents here:
            "new detatched sub": {
                input: `
x=B:Ca;C2-1 s=S.:a;Ba=a;Bmaster=2`,
                commit: "2",
                parents: [],
                exclude: () => false,
                detatch: true,
                expected: `
x=E:C*#s s/a=a;Fstitched/converted/2=s`,
            },
            "new detatched sub, with parent": {
                input: `
x=B:Ca;C2-1 s=S.:a;Ba=a;Bmaster=2`,
                commit: "2",
                parents: ["1"],
                exclude: () => false,
                detatch: true,
                expected: `
x=E:C*#s-1 s/a=a;Fstitched/converted/2=s`,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const stitcher = co.wrap(function *(repos, maps) {
                    const x = repos.x;
                    const revMap = maps.reverseCommitMap;
                    const commit = yield x.getCommit(revMap[c.commit]);
                    const parents =
                                  yield c.parents.map(co.wrap(function *(sha) {
                        return yield x.getCommit(revMap[sha]);
                    }));
                    const stitch = yield StitchUtil.writeStitchedCommit(
                                                                    x,
                                                                    commit,
                                                                    parents,
                                                                    c.exclude,
                                                                    c.detatch);
                    const commitMap = {};
                    commitMap[stitch.id().tostrS()] = "s";
                    return {
                        commitMap,
                    };
                });
                yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                               c.expected,
                                                               stitcher,
                                                               c.fails, {
                    actualTransformer: refMapper,
                });
            }));
        });
    });
    it("detached messaging", co.wrap(function *() {

        // We don't need to retest the summarize logic, just that we stitch
        // the messages together properly.

        const state = "B:Ca;C2-1 s=S.:a;Ba=a;Bmaster=2";
        const written = yield RepoASTTestUtil.createRepo(state);
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const stitch = yield StitchUtil.writeStitchedCommit(repo,
                                                            head,
                                                            [head],
                                                            () => false,
                                                            true);
        const subCommitRef = yield NodeGit.Reference.lookup(repo,
                                                            "refs/heads/a");
        const subCommit = yield repo.getCommit(subCommitRef.target());
        const summary = StitchUtil.summarizeSubCommit("s", subCommit);
        const expected = head.message() + "\n" + summary;
        const actual = stitch.message();
        assert.deepEqual(expected.split("\n"), actual.split("\n"));
    }));
    describe("listFetches", function () {
        const cases = {
            "trivial": {
                state: "S",
                toFetch: [],
                exclude: () => false,
                numParallel: 2,
                expected: {},
            },
            "a sub, not picked": {
                state: "S:C2-1 s=S/a:1;Bmaster=2",
                toFetch: ["1"],
                exclude: () => false,
                numParallel: 2,
                expected: {},
            },
            "added sub": {
                state: "S:C2-1 s=S/a:1;Bmaster=2",
                toFetch: ["2"],
                exclude: () => false,
                numParallel: 2,
                expected: {
                    "s": [
                        { metaSha: "2", url: "/a", sha: "1" },
                    ],
                },
            },
            "added sub excluded": {
                state: "S:C2-1 s=S/a:1;Bmaster=2",
                toFetch: ["2"],
                exclude: (name) => "s" === name,
                numParallel: 2,
                expected: {},
            },
            "changed sub": {
                state: "S:Cx-1;Bx=x;C2-1 s=S/a:1;C3-2 s=S/a:x;Bmaster=3",
                toFetch: ["3"],
                exclude: () => false,
                numParallel: 2,
                expected: {
                    "s": [
                        { metaSha: "3", url: "/a", sha: "x" },
                    ],
                },
            },
            "changed sub excluded": {
                state: "S:Cx-1;Bx=x;C2-1 s=S/a:1;C3-2 s=S/a:x;Bmaster=3",
                toFetch: ["3"],
                exclude: (name) => "s" === name,
                numParallel: 2,
                expected: {},
            },
            "two changes in a sub": {
                state: "S:Cx-1;Bx=x;C2-1 s=S/a:1;C3-2 s=S/a:x;Bmaster=3",
                toFetch: ["2", "3"],
                exclude: () => false,
                numParallel: 2,
                expected: {
                    "s": [
                        { metaSha: "3", url: "/a", sha: "x" },
                        { metaSha: "2", url: "/a", sha: "1" },
                    ],
                },
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written = yield RepoASTTestUtil.createRepo(c.state);
                const repo = written.repo;
                const revMap = written.oldCommitMap;
                const commitMap = written.commitMap;
                const toFetch = yield c.toFetch.map(co.wrap(function *(e) {
                    const sha = revMap[e];
                    return yield repo.getCommit(sha);
                }));
                const result = yield StitchUtil.listFetches(repo,
                                                            toFetch,
                                                            c.exclude,
                                                            c.numParallel);
                function mapFetch(f) {
                    return {
                        url: f.url,
                        metaSha: commitMap[f.metaSha],
                        sha: commitMap[f.sha],
                    };
                }
                for (let name in result) {
                    result[name] = result[name].map(mapFetch);
                }
                assert.deepEqual(result, c.expected);
            }));
        });
    });
    describe("fetchSubCommits", function () {
        const cases = {
            "trivial": {
                input: "a=B|x=S",
                fetches: [],
                url: "a",
            },
            "one, w sub": {
                input: "a=B|x=U",
                fetches: [
                    {
                        url: "a",
                        sha: "1",
                        metaSha: "2"
                    }
                ],
                url: "a",
                expected: "x=E:Fstitched/fetched/2/sub/1=1",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const fetcher = co.wrap(function *(repos, maps) {
                    const x = repos.x;
                    const revMap = maps.reverseCommitMap;
                    const fetches = c.fetches.map(e => {
                        return {
                            url: e.url,
                            sha: revMap[e.sha],
                            metaSha: revMap[e.metaSha],
                        };
                    });
                    const url = maps.reverseUrlMap[c.url];
                    yield StitchUtil.fetchSubCommits(x, url, fetches);
                });
                yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                               c.expected,
                                                               fetcher,
                                                               c.fails, {
                    actualTransformer: refMapper,
                });

            }));
        });
    });
});
