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

const RepoASTTestUtil     = require("../../lib/util/repo_ast_test_util");
const RepoStatus          = require("../../lib/util/repo_status");
const Status              = require("../../lib/util/status");
const SubmoduleUtil       = require("../../lib/util/submodule_util");
const SubmoduleConfigUtil = require("../../lib/util/submodule_config_util");

// test utilities

/**
 * Return a new `RepoStatus` object having the same value as the specified
 * `status` but with all commit shas replaced by commits in the specified
 * `comitMap` and all urls replaced by the values in the specified `urlMap`.
 *
 * @param {RepoStatus} status
 * @param {Object}     commitMap
 * @param {Object}     urlMap
 * @return {RepoStatus}
 */
let remapRepoStatus;

/**
 * Return a new `RepoStatus.Submodule` object having the same value as the
 * specified `sub` but with all commit shas replaced by commits in the
 * specified `commitMap` and all urls replaced by the values in the specified
 * `urlMap`.
 *
 * @param {RepoStatus.Submodule} sub
 * @param {Object}               commitMap from sha to sha
 * @param {Object}               urlMap    from url to url
 * @return {RepoStatus.Submodule}
 */
function remapSubmodule(sub, commitMap, urlMap) {
    assert.instanceOf(sub, RepoStatus.Submodule);
    assert.isObject(commitMap);
    assert.isObject(urlMap);

    function mapSha(sha) {
        return sha && (commitMap[sha] || sha);
    }

    function mapUrl(url) {
        return url && (urlMap[url] || url);
    }

    return new RepoStatus.Submodule({
        indexStatus: sub.indexStatus,
        indexSha: mapSha(sub.indexSha),
        indexShaRelation: sub.indexShaRelation,
        indexUrl: mapUrl(sub.indexUrl),
        commitSha: mapSha(sub.commitSha),
        commitUrl: mapUrl(sub.commitUrl),
        workdirShaRelation: sub.workdirShaRelation,
        repoStatus: sub.repoStatus &&
                            remapRepoStatus(sub.repoStatus, commitMap, urlMap),
    });
}

remapRepoStatus = function (status, commitMap, urlMap) {
    assert.instanceOf(status, RepoStatus);
    assert.isObject(commitMap);
    assert.isObject(urlMap);

    function mapSha(sha) {
        return sha && (commitMap[sha] || sha);
    }

    let submodules = {};
    const baseSubmods = status.submodules;
    Object.keys(baseSubmods).forEach(name => {
        submodules[name] = remapSubmodule(baseSubmods[name],
                                          commitMap,
                                          urlMap);
    });

    return new RepoStatus({
        currentBranchName: status.currentBranchName,
        headCommit: mapSha(status.headCommit),
        staged: status.staged,
        submodules: submodules,
        workdir: status.workdir,
    });
};

describe("Status", function () {

    describe("test.remapSubmodule", function () {
        const Submodule = RepoStatus.Submodule;
        const RELATION  = Submodule.COMMIT_RELATION;
        const FILESTATUS = RepoStatus.FILESTATUS;
        const cases = {
            "all": {
                input: new Submodule({
                    indexSha: "1",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                }),
                commitMap: { "1": "2" },
                urlMap: { "a": "b" },
                expected: new Submodule({
                    indexSha: "2",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "b",
                    commitSha: "2",
                    commitUrl: "b",
                }),
            },
            "some skipped": {
                input: new Submodule({
                    indexStatus: FILESTATUS.ADDED,
                    indexSha: "1",
                    indexUrl: "x",
                }),
                commitMap: { "1": "2" },
                urlMap: { "x": "y" },
                expected: new Submodule({
                    indexStatus: FILESTATUS.ADDED,
                    indexSha: "2",
                    indexUrl: "y",
                }),
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = remapSubmodule(c.input,
                                              c.commitMap,
                                              c.urlMap);
                assert.deepEqual(result, c.expected);
            });
        });
    });

    describe("test.remapRepoStatus", function () {
        const FILESTATUS = RepoStatus.FILESTATUS;
        const Submodule = RepoStatus.Submodule;
        const RELATION = Submodule.COMMIT_RELATION;
        const cases = {
            trivial: {
                input: new RepoStatus(),
                commitMap: {},
                urlMap: {},
                expected: new RepoStatus(),
            },
            "all fields but submodules": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    staged: { x: RepoStatus.FILESTATUS.ADDED },
                    workdir: { y: RepoStatus.FILESTATUS.ADDED },
                }),
                commitMap: { "1": "3"},
                urlMap: {},
                expected: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "3",
                    staged: { x: RepoStatus.FILESTATUS.ADDED },
                    workdir: { y: RepoStatus.FILESTATUS.ADDED },
                }),
            },
            "with a sub": {
                input: new RepoStatus({
                    submodules: {
                        s: new Submodule({
                            indexSha: "1",
                            indexShaRelation: RELATION.SAME,
                            indexUrl: "a",
                            commitSha: "1",
                            commitUrl: "a",
                        }),
                    },
                }),
                commitMap: { "1": "2" },
                urlMap: { "a": "b" },
                expected: new RepoStatus({
                    submodules: {
                        s: new Submodule({
                            indexSha: "2",
                            indexShaRelation: RELATION.SAME,
                            indexUrl: "b",
                            commitSha: "2",
                            commitUrl: "b",
                        }),
                    },
                }),
            },
            "with a sub having a repo": {
                input: new RepoStatus({
                    submodules: {
                        s: new Submodule({
                            indexSha: "1",
                            indexUrl: "a",
                            indexStatus: FILESTATUS.ADDED,
                            workdirShaRelation: RELATION.SAME,
                            repoStatus: new RepoStatus({
                                headCommit: "1",
                            }),
                        }),
                    },
                }),
                commitMap: { "1": "2" },
                urlMap: { "a": "b" },
                expected: new RepoStatus({
                    submodules: {
                        s: new Submodule({
                            indexSha: "2",
                            indexUrl: "b",
                            workdirShaRelation: RELATION.SAME,
                            indexStatus: FILESTATUS.ADDED,
                            repoStatus: new RepoStatus({
                                headCommit: "2",
                            }),
                        }),
                    },
                }),
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = remapRepoStatus(c.input, c.commitMap, c.urlMap);
                assert.deepEqual(result, c.expected);
            });
        });
    });

    describe("printFileStatuses", function () {
        // I don't want to try to test for the specific format, just that we
        // mention changed files.

        const STAT = RepoStatus.FILESTATUS;

        const cases = {
            "trivial": { input: new RepoStatus(), empty: true, },
            "with current branch": {
                input: new RepoStatus({ currenBranchName: "foo" }),
                empty: true,
            },
            "with head": {
                input: new RepoStatus({headCommit: "1"}),
                empty: true,
            },
            "with staged": {
                input: new RepoStatus({
                    staged: { "foo": STAT.ADDED },
                }),
                regex: /foo/,
            },
            "with workdir": {
                input: new RepoStatus({
                    workdir: { foobar: STAT.REMOVED },
                }),
                regex: /foobar/,
            },
            "with untracked": {
                input: new RepoStatus({
                    workdir: { uuuu: STAT.ADDED },
                }),
                regex: /uuuu/,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = Status.printFileStatuses(c.input);
                if (c.empty) {
                    assert.equal(result, "");
                }
                else {
                    assert.notEqual(result, "");
                    assert.match(result, c.regex);
                }
            });
        });
    });

    describe("printSubmoduleStatus", function () {
        // I don't want to try to test for the specific format, just that we
        // mention changes.

        const Submodule = RepoStatus.Submodule;
        const RELATION = Submodule.COMMIT_RELATION;
        const STAT = RepoStatus.FILESTATUS;

        const cases = {
            "unchanged": { 
                input: new Submodule({
                    indexSha: "1",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                }),
                regex: null,
            },
            "removed": { 
                input: new Submodule({
                    indexStatus: STAT.REMOVED,
                    commitSha: "1",
                    commitUrl: "a",
                }),
                regex: /Removed/,
            },
            "added": {
                input: new Submodule({
                    indexStatus: STAT.ADDED,
                    indexUrl: "xyz",
                    indexSha: "1",
                }),
                regex: /Added.*xyz/,
            },
            "changed url": {
                input: new Submodule({
                    indexStatus: STAT.MODIFIED,
                    indexUrl: "qrs",
                    indexSha: "1",
                    indexShaRelation: RELATION.SAME,
                    commitUrl: "xyz",
                    commitSha: "1",
                }),
                regex: /Staged change to URL.*qrs/,
            },
            "new commit staged": {
                input: new Submodule({
                    indexStatus: STAT.MODIFIED,
                    indexUrl: "x",
                    indexSha: "2",
                    indexShaRelation: RELATION.AHEAD,
                    commitUrl: "x",
                    commitSha: "1",
                }),
                regex: /New commit/,
            },
            "old commit staged": {
                input: new Submodule({
                    indexStatus: STAT.MODIFIED,
                    indexUrl: "x",
                    indexSha: "2",
                    indexShaRelation: RELATION.BEHIND,
                    commitUrl: "x",
                    commitSha: "1",
                }),
                regex: /Reset to old commit/,
            },
            "unrelated staged": {
                input: new Submodule({
                    indexStatus: STAT.MODIFIED,
                    indexUrl: "x",
                    indexSha: "2",
                    indexShaRelation: RELATION.UNRELATED,
                    commitUrl: "x",
                    commitSha: "1",
                }),
                regex: /Changed to unrelated commit/,
            },
            "unknown staged": {
                input: new Submodule({
                    indexStatus: STAT.MODIFIED,
                    indexUrl: "x",
                    indexSha: "2",
                    indexShaRelation: RELATION.UNKNOWN,
                    commitUrl: "x",
                    commitSha: "1",
                }),
                regex: /cannot verify relation/,
            },
            "new head commit": {
                input: new Submodule({
                    indexUrl: "x",
                    indexSha: "2",
                    indexShaRelation: RELATION.SAME,
                    commitUrl: "x",
                    commitSha: "2",
                    workdirShaRelation: RELATION.AHEAD,
                    repoStatus: new RepoStatus({
                        headCommit: "1",
                    }),
                }),
                regex: /New commit/
            },
            "new head commit in new submodule": {
                input: new Submodule({
                    indexStatus: STAT.ADDED,
                    indexUrl: "x",
                    indexSha: "2",
                    workdirShaRelation: RELATION.AHEAD,
                    repoStatus: new RepoStatus({
                        headCommit: "1",
                    }),
                }),
                regex: /New commit/
            },
            "behind head commit": {
                input: new Submodule({
                    indexUrl: "x",
                    indexSha: "2",
                    indexShaRelation: RELATION.SAME,
                    commitUrl: "x",
                    commitSha: "2",
                    workdirShaRelation: RELATION.BEHIND,
                    repoStatus: new RepoStatus({
                        headCommit: "1",
                    }),
                }),
                regex: /Open repo has old commit/
            },
            "unrelated head commit": {
                input: new Submodule({
                    indexUrl: "x",
                    indexSha: "2",
                    indexShaRelation: RELATION.SAME,
                    commitUrl: "x",
                    commitSha: "2",
                    workdirShaRelation: RELATION.UNRELATED,
                    repoStatus: new RepoStatus({
                        headCommit: "1",
                    }),
                }),
                regex: /Open repo has unrelated commit/
            },
            "file statuses": {
                // We forward this, just validate that it does so.
                input: new Submodule({
                    indexStatus: STAT.ADDED,
                    indexSha: "1",
                    indexUrl: "a",
                    workdirShaRelation: RELATION.SAME,
                    repoStatus: new RepoStatus({
                        headCommit: "1",
                        staged: { foo: STAT.ADDED },
                    })
                }),
                regex: /foo/,
            },
            "bad branch": {
                input: new Submodule({
                    indexStatus: STAT.ADDED,
                    indexSha: "1",
                    indexUrl: "a",
                    workdirShaRelation: RELATION.SAME,
                    repoStatus: new RepoStatus({
                        headCommit: "1",
                        currentBranchName: "bar",
                    })
                }),
                branch: "foo",
                regex: /On wrong branch.*bar/,
            },
            "no branch": {
                input: new Submodule({
                    indexStatus: STAT.ADDED,
                    indexSha: "1",
                    indexUrl: "a",
                    workdirShaRelation: RELATION.SAME,
                    repoStatus: new RepoStatus({
                        headCommit: "1",
                    })
                }),
                branch: "foo",
                regex: /not on a branch/,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const branch = c.branch || null;
                const result = Status.printSubmoduleStatus(branch, c.input);
                if (c.regex) {
                    assert.notEqual(result, "");
                    assert.match(result, c.regex);
               }
                else {
                    assert.equal(result, "");
                }
            });
        });
    });

    describe("getSubmoduleStatus", function () {
        // We will use `x` for the repo name and `s` for the submodule name.

        /**
         * We're going to cheat here.  We know that `getSubmoduleStatus` will
         * call this method to get repo status.  We just need to make sure that
         * it does so, and that it correctly uses the `headCommit` field, which
         * is all we need to load to do so.
         */
        const getRepoStatus = co.wrap(function *(repo) {
            const head = yield repo.getHeadCommit();
            return new RepoStatus({
                headCommit: head.id().tostrS(),
            });
        });

        const FILESTATUS = RepoStatus.FILESTATUS;
        const Submodule = RepoStatus.Submodule;
        const RELATION = Submodule.COMMIT_RELATION;

        const cases = {
            "unchanged": {
                state: "a=S|x=S:C2-1 s=Sa:1;Bmaster=2",
                expected: new Submodule({
                    indexSha: "1",
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                    indexShaRelation: RELATION.SAME,
                }),
            },
            "added": {
                state: "a=S|x=S:I s=Sa:1",
                expected: new Submodule({
                    indexSha: "1",
                    indexUrl: "a",
                    indexStatus: FILESTATUS.ADDED,
                })
            },
            "removed": {
                state: "a=S|x=S:C2-1 s=Sa:1;Bmaster=2;I s",
                expected: new Submodule({
                    commitSha: "1",
                    commitUrl: "a",
                    indexStatus: FILESTATUS.REMOVED,
                }),
            },
            "new commit": {
                state: "a=S:C3-1;Bfoo=3|x=S:C2-1 s=Sa:1;I s=Sa:3;Bmaster=2",
                expected: new Submodule({
                    indexSha: "3",
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                    indexStatus: FILESTATUS.MODIFIED,
                    indexShaRelation: RELATION.UNKNOWN,
                }),
            },
            "new commit -- known": {
                state: "a=S:C3-1;Bfoo=3|x=S:C2-1 s=Sa:1;I s=Sa:3;Bmaster=2;Os",
                expected: new Submodule({
                    indexSha: "3",
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                    indexStatus: FILESTATUS.MODIFIED,
                    indexShaRelation: RELATION.AHEAD,
                    workdirShaRelation: RELATION.SAME,
                    repoStatus: new RepoStatus({
                        headCommit: "3",
                    }),
                }),
            },
            "new url": {
                state: "a=S|x=S:C2-1 s=Sa:1;I s=Sb:1;Bmaster=2",
                expected: new Submodule({
                    indexSha: "1",
                    indexUrl: "b",
                    commitSha: "1",
                    commitUrl: "a",
                    indexStatus: FILESTATUS.MODIFIED,
                    indexShaRelation: RELATION.SAME,
                }),
            },
            "unchanged open": {
                state: "a=S|x=S:C2-1 s=Sa:1;Bmaster=2;Os",
                expected: new Submodule({
                    indexSha: "1",
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                    indexShaRelation: RELATION.SAME,
                    workdirShaRelation: RELATION.SAME,
                    repoStatus: new RepoStatus({
                        headCommit: "1",
                    }),
                }),
            },
            "new in open": {
                state: "a=S:C2-1;Bb=2|x=S:I s=Sa:1;Os H=2",
                expected: new Submodule({
                    indexSha: "1",
                    indexUrl: "a",
                    indexStatus: FILESTATUS.ADDED,
                    workdirShaRelation: RELATION.AHEAD,
                    repoStatus: new RepoStatus({
                        headCommit: "2",
                    }),
                }),
            },
            "old in open": {
                state: "a=S:C2-1;Bb=2|x=S:I s=Sa:2;Os H=1",
                expected: new Submodule({
                    indexSha: "2",
                    indexUrl: "a",
                    indexStatus: FILESTATUS.ADDED,
                    workdirShaRelation: RELATION.BEHIND,
                    repoStatus: new RepoStatus({
                        headCommit: "1",
                    }),
                }),
            },
            "unrelated in open": {
                state: "a=S:C2-1;C3-1;Bb=2;Bc=3|x=S:I s=Sa:2;Os H=3",
                expected: new Submodule({
                    indexSha: "2",
                    indexUrl: "a",
                    indexStatus: FILESTATUS.ADDED,
                    workdirShaRelation: RELATION.UNRELATED,
                    repoStatus: new RepoStatus({
                        headCommit: "3",
                    }),
                }),
            }
        };

        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const w = yield RepoASTTestUtil.createMultiRepos(c.state);
                const repo = w.repos.x;
                const index = yield repo.index();
                const indexUrls =
                 yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, index);
                const commit = yield repo.getHeadCommit();
                const commitUrls =
                     yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo,
                                                                       commit);
                const indexUrl = indexUrls.s || null;
                const commitUrl = commitUrls.s || null;
                const commitTree = yield commit.getTree();
                const isVisible = yield SubmoduleUtil.isVisible(repo, "s");
                const result = yield Status.getSubmoduleStatus("s",
                                                               repo,
                                                               indexUrl,
                                                               commitUrl,
                                                               index,
                                                               commitTree,
                                                               isVisible,
                                                               getRepoStatus);
                assert.instanceOf(result, RepoStatus.Submodule);
                const mappedResult = remapSubmodule(result,
                                                    w.commitMap,
                                                    w.urlMap);
                assert.deepEqual(mappedResult, c.expected);
            }));
        });
    });

    describe("getRepoStatus", function () {
        // We will get the status of the repo named `x`.

        const cases = {
            "trivial": {
                state: "x=S",
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "1",
                }),
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const w = yield RepoASTTestUtil.createMultiRepos(c.state);
                const result = yield Status.getRepoStatus(w.repos.x);
                assert.instanceOf(result, RepoStatus);
                const mappedResult = remapRepoStatus(result,
                                                     w.commitMap,
                                                     w.urlMap);
                assert.deepEqual(mappedResult, c.expected);
            }));
        });
    });
});
