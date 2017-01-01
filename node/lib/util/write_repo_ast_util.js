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

/**
 * @module {WriteRepoASTUtil}
 *
 * This module contains utilities for writing `RepoAST` objects out into
 * `NodeGit.Repository` objects.
 */

const assert   = require("chai").assert;
const co       = require("co");
const exec     = require("child-process-promise").exec;
const fs       = require("fs-promise");
const mkdirp   = require("mkdirp");
const NodeGit  = require("nodegit");
const path     = require("path");

const DoWorkQueue         = require("./do_work_queue");
const RebaseFileUtil      = require("./rebase_file_util");
const RepoAST             = require("./repo_ast");
const RepoASTUtil         = require("./repo_ast_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
//const Stopwatch           = require("./stopwatch");
const TestUtil            = require("./test_util");

                         // Begin module-local methods

const execMakeTree = co.wrap(function *(repo, path) {
    let result;
    try {
        const command = `\
cat '${path}' | git -C '${repo.path()}' mktree --batch`;
        result = yield exec(command, { maxBuffer: 50000000 });
    }
    catch (e) {
        throw e;
    }

    // Last one is always empty; remove it.
    const ids = result.stdout.split("\n");
    return ids.slice(0, ids.length - 1);
});

function closeStream(stream) {
    return new Promise(callback => {
        stream.on("finish", () => {
            callback();
        });
        stream.end();
    });
}

/**
 * Write the specified `data` to the specified `repo` and return its hash
 * value.
 *
 * @async
 * @private
 * @param {NodeGit.Repository} repo
 * @param {String}             data
 * @return {String}
 */
const hashObject = co.wrap(function *(repo, data) {
    const db = yield repo.odb();
    const BLOB = 3;
    const res = yield db.write(data, data.length, BLOB);
    return res.tostrS();
});

/**
 * Configure the specified `repo` to have settings needed by git-meta tests.
 *
 * @param {NodeGit.Repository}
 */
const configRepo = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);
    const config = yield repo.config();
    yield config.setString("uploadpack.allowReachableSHA1InWant", "true");
});

/**
 * Return an array of tree ids corresponding to the specified `commitTrees` in
 * the specified `repo`.  Use the specified `shaMap` to map the logical commit
 * ids of submodule heads to their actual physical ids.
 *
 * @async
 * @param {NodeGit.Repository}    repo
 * @param {Object[]}              commitTrees array of trees to render
 * @param {Object}                shaMap maps logical to physical ID
 * @return {String[]} array of tree ids
 */
const writeCommitTrees = co.wrap(function *(repo, commitTrees, shaMap) {

    const tempDir  = yield TestUtil.makeTempDir();

    let emptyTree = null;
    const getEmptyTree = co.wrap(function *() {
        if (null === emptyTree) {
            const builder = yield NodeGit.Treebuilder.create(repo, null);
            const treeObj = builder.write();
            emptyTree = treeObj.tostrS();
        }
        return emptyTree;
    });

    class TreeLevel {

        constructor() {

            // Paths and data go together, and will contain the elements to
            // write for each tree.  Paths contains arrays of strings, and data
            // will contains arrays, each sub-array having elements that are
            // one of:
            // - a number -- mapping to a blob index
            // - a string -- a commit sha
            // - a entry object: containing a tree 'level' and 'offset'.

            this.paths = [];
            this.data  = [];

            this.resultIds = [];  // Array of written trees.
        }
    }

    let levels = [];
    let blobs = [];

    /**
     * Return a tree level and offset or `null` for an empty tree.
     *
     * @param {Object} tree map from path to content
     * @param {Number} level level at which to put data
     * @return {[Object]}
     * @return {Number} return.level
     * @return {Number} return.offset
     */
    function stageTree(tree, level) {
        let treeLevel = level;  // Will contain final level for this tree

        // pathEntries and dataEntries map to 'path' and 'data' in 'TreeLevel'.

        let pathEntries = [];
        let dataEntries = [];

        for (let path in tree) {
            pathEntries.push(path);
            const data = tree[path];

            // If the data is a string or submodule, it's a leaf and we can
            // just push it.

            if ("string" === typeof data) {
                const blobIndex = blobs.length;
                blobs.push(data);
                dataEntries.push(blobIndex);
            }
            else if (data instanceof RepoAST.Submodule) {
                const subSha = data.sha;
                assert.property(shaMap, subSha, "missing submodule sha");
                dataEntries.push(shaMap[subSha]);
            }
            else {
                // Otherwise, we need to recursively stage the subtree.  The
                // new level for the current tree will be the maximum of the
                // level needed to write this subtree (plus 1) and the
                // previous maximum level -- we cannot write the current tree
                // until at least this new subtree is written.

                const subTree = stageTree(data, level);
                dataEntries.push(subTree);
                treeLevel = Math.max(treeLevel, subTree.level + 1);
            }
        }

        // If no entries in the tree, return a null to indicate an empty tree.

        if (0 === pathEntries.length) {
            return null;                                              // RETURN
        }

        // Make a new tree level if needed.

        if (treeLevel === levels.length) {
            levels.push(new TreeLevel());
        }

        // This is the level at which this tree will live:

        const targetLevel = levels[treeLevel];

        // Offset is the next location.

        const offset = targetLevel.paths.length;

        // Copy entries.

        targetLevel.paths.push(pathEntries);
        targetLevel.data.push(dataEntries);

        return {
            level: treeLevel,
            offset: offset,
        };
    }

    // Stage all the commits, remembering how to access the tree generated for
    // each one by storing the tree level and offset in 'records'.

    const records = commitTrees.map(tree => stageTree(tree, 0));

    // Generate blob hashes in parallel.

    const blobData = yield DoWorkQueue.doInParallel(blobs, function (blob) {
        return hashObject(repo, blob);
    });

    // Write out the levels in order of least to most dependent.

    const writeLevel = co.wrap(function *(treeLevel, index) {
        const pathEntries = treeLevel.paths;
        const dataEntries = treeLevel.data;
        const writeBatch = co.wrap(function *(batchPaths, offset) {
            const tempPath = path.join(tempDir, "" + index + "." + offset);
            const stream = fs.createWriteStream(tempPath);
            for (let i = 0; i < batchPaths.length; ++i) {
                const paths = batchPaths[i];
                const dataEntry = dataEntries[i + offset];

                // Each of these is one line in the tree.

                if (0 !== i) {
                    stream.write("\n");
                }

                for (let j = 0; j < paths.length; ++j) {
                    const path = paths[j];
                    const data = dataEntry[j];
                    if ("number" === typeof data) {
                        const blob = blobData[data];
                        stream.write(`100644 blob ${blob}\t${path}\n`);
                    }
                    else if ("string" === typeof data) {
                        stream.write(`160000 commit ${data}\t${path}\n`);
                    }
                    else {
                        const treeId =
                                     levels[data.level].resultIds[data.offset];
                        stream.write(`040000 tree ${treeId}\t${path}\n`);
                    }
                }
            }
            yield closeStream(stream);
            return yield execMakeTree(repo, tempPath);
        });
        treeLevel.resultIds = yield DoWorkQueue.doInBatches(pathEntries,
                                                            4,
                                                            writeBatch);
    });

    // Write out the levels in order.

    for (let i = 0; i < levels.length; ++i) {
        yield writeLevel(levels[i], i);
    }

    // Return the resulting tree ids.

    let result = [];
    for (let i = 0; i < records.length; ++i) {
        const r = records[i];
        if (null === r) {
            result.push(yield getEmptyTree());
        }
        else {
            result.push(levels[r.level].resultIds[r.offset]);
        }
    }
    return result;
});

/**
 * Write the commits having the specified `shas` from the specified `commits`
 * map into the specified `repo`.  Read and write logical to physical sha
 * mappings to and from the specified `oldCommitMap`.  Use the specifeid
 * `renderCache` to store computed directory structures.  Return a map from new
 * (physical) sha from the original (logical) sha of the commits written.
 *
 * @async
 * @param {Object} oldCommitMap old to new sha, read/write
 * @param {Object} renderCache  syntesized directory cache, read/write
 * @param {NodeGit.Repository} repo
 * @param {Object}             commits sha to `RepoAST.Commit`
 * @param {String[]}           shas    array of shas to write
 * @return {Object} maps generated to original commit id
 */
exports.writeCommits = co.wrap(function *(oldCommitMap,
                                          renderCache,
                                          repo,
                                          commits,
                                          shas) {
    assert.isObject(oldCommitMap);
    assert.isObject(renderCache);
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isObject(commits);
    assert.isArray(shas);

    let newCommitMap = {};  // from new to old sha

    const sig = repo.defaultSignature();

    const commitObjs = {};  // map from new id to `Commit` object

    const commitWriters = {};  // map from id to promise

   const writeCommit = co.wrap(function *(sha, treeId) {
        // TODO: extend libgit2 and nodegit to allow submoduel manipulations to
        // `TreeBuilder`.  For now, we will do this ourselves using the `git`
        // commandline tool.
        //
        // - First, we calculate the tree describred by the commit at `sha`.
        // - Then, we build a string that describes that as if it were output
        //   by `ls-tree`.
        // - Next, we invoke `git-mktree` to create a tree id
        // - finally, we invoke `git-commit-tree` to create the commit.

        // Recursively get commit ids for parents.

        const commit = commits[sha];
        const parents = commit.parents;

        let newParents = [];  // Array of commit IDs
        for (let i = 0; i < parents.length; ++i) {
            const parent = parents[i];
            let parentSha = oldCommitMap[parent];
            if (undefined === parentSha) {
                parentSha = yield commitWriters[parent];
            }
            const parentCommit = yield repo.getCommit(parentSha);
            newParents.push(parentCommit);
        }

        // Calculate the tree.  `tree` describes the directory tree specified
        // by the commit at `sha`.

        const treeObj = yield repo.getTree(treeId);

        // Make a commit from the tree.

        const commitId = yield NodeGit.Commit.create(repo,
                                                     0,
                                                     sig,
                                                     sig,
                                                     0,
                                                     commit.message,
                                                     treeObj,
                                                     newParents.length,
                                                     newParents);
        const commitSha = commitId.tostrS();
        oldCommitMap[sha] = commitSha;
        newCommitMap[commitSha] = sha;
        commitObjs[commitSha] = (yield repo.getCommit(commitSha));
        return commitSha;
    });

    const writeCommitSet = co.wrap(function *(shas) {
        const trees = shas.map(sha => {
            const flatTree = RepoAST.renderCommit(renderCache, commits, sha);
            return exports.buildDirectoryTree(flatTree);
        });
        const treeIds = yield writeCommitTrees(repo, trees, oldCommitMap);
        treeIds.forEach((treeId, index) => {
            const sha = shas[index];
            commitWriters[sha] = writeCommit(sha, treeId);
        });
        yield DoWorkQueue.doInParallel(shas, sha => {
            return commitWriters[sha];
        });
    });

    const commitsByLevel = exports.levelizeCommitTrees(commits, shas);

    for (let i = 0; i < commitsByLevel.length; ++i) {
        const level = commitsByLevel[i];
        yield writeCommitSet(level);
    }
    return newCommitMap;
});

/**
 * Write all of the specified `commits` into the specified `repo`.
 *
 * @async
 * @private
 * @param {NodeGit.Repository} repo
 * @param {Object}             commits sha to `RepoAST.Commit`
 * @return {Object}
 * @return {Object} return.oldToNew  maps original to generated commit id
 * @return {Object} return.newToOld  maps generated to original commit id
 */
const writeAllCommits = co.wrap(function *(repo, commits) {
    const renderCache = {};
    const oldCommitMap = {};
    const newIds = yield exports.writeCommits(oldCommitMap,
                                              renderCache,
                                              repo,
                                              commits,
                                              Object.keys(commits));
    return {
        newToOld: newIds,
        oldToNew: oldCommitMap,
    };
});

/**
 * Configure the specified `repo` to have the state described in the specified
 * `ast`.  Use the specified `commitMap` to map commit IDs in `ast`.  Return
 * the resulting `NodeGit.Repository` object, which may not be `repo`, but will
 * be at the same location as `repo` was.
 *
 * @private
 * @async
 * @param {NodeGit.Repository} repo
 * @param {RepoAST}            ast
 * @param {Object}             commitMap  old to new id
 */
const configureRepo = co.wrap(function *(repo, ast, commitMap) {
    const makeRef = co.wrap(function *(name, commit) {
        const newSha = commitMap[commit];
        const newId = NodeGit.Oid.fromString(newSha);
        yield NodeGit.Reference.create(repo, name, newId, 0, "made ref");
    });

    let newHeadSha = null;
    if (null !== ast.head) {
        newHeadSha = commitMap[ast.head];
    }

    // Then create the branches we want.

    for (let branch in ast.branches) {
        yield makeRef("refs/heads/" + branch, ast.branches[branch]);
    }

    // Then create the refs

    for (let ref in ast.refs) {
        yield makeRef("refs/" + ref, ast.refs[ref]);
    }

    // Handle remotes.

    for (let remoteName in ast.remotes) {
        const remote = ast.remotes[remoteName];
        yield NodeGit.Remote.create(repo, remoteName, remote.url);

        // Explicitly create the desired refs for the remote.

        for (let branchName in remote.branches) {
            yield makeRef(`refs/remotes/${remoteName}/${branchName}`,
                          remote.branches[branchName]);
        }
    }

    // Deal with bare repos.

    if (ast.bare) {
        if (null !== ast.currentBranchName) {
            repo.setHead("refs/heads/" + ast.currentBranchName);
        }
        else {
            repo.setHeadDetached(newHeadSha);
        }
    }
    else if (null !== ast.currentBranchName) {
        const currentBranch =
                   yield repo.getBranch("refs/heads/" + ast.currentBranchName);
        yield repo.checkoutBranch(currentBranch);
    }
    else if (null !== ast.head) {
        const headCommit = yield repo.getCommit(newHeadSha);
        repo.setHeadDetached(newHeadSha);
        yield NodeGit.Reset.reset(repo, headCommit, NodeGit.Reset.TYPE.HARD);
    }

    const notes = ast.notes;
    const sig = repo.defaultSignature();
    for (let notesRef in notes) {
        const commits = notes[notesRef];
        for (let commit in commits) {
            const message = commits[commit];
            yield NodeGit.Note.create(repo, notesRef, sig, sig,
                                      commitMap[commit], message, 0);
        }
    }

    if (!ast.bare) {

        let indexHead = ast.head;

        // Set up a rebase if there is one, this has to come right before
        // setting up the workdir, otherwise the rebase won't be allowed to
        // start.

        if (null !== ast.rebase) {
            const rebase = ast.rebase;
            const originalSha = commitMap[rebase.originalHead];
            const ontoSha = commitMap[rebase.onto];
            const original = yield NodeGit.AnnotatedCommit.lookup(repo,
                                                                  originalSha);
            const onto = yield NodeGit.AnnotatedCommit.lookup(repo, ontoSha);

            // `init` creates the rebase, but it's not actually started (some
            // files are not made) until the first call to `next`.

            const rb  =
                   yield NodeGit.Rebase.init(repo, original, onto, null, null);
            yield rb.next();
            const gitDir = repo.path();
            const rbDir = yield RebaseFileUtil.findRebasingDir(gitDir);
            const headNamePath = path.join(gitDir,
                                           rbDir,
                                           RebaseFileUtil.headFileName);
            yield fs.writeFile(headNamePath, rebase.headName + "\n");

            // Starting a rebase will change the HEAD  If we render the index
            // against `ast.head`, it will be incorrect; we must adjust so that
            // we render against the new head, `onto`.

            indexHead = rebase.onto;
        }

        // Set up the index.  We render the current commit and apply the index
        // on top of it.

        let flatTree = ast.index;
        if (null !== indexHead) {
            flatTree =
                  yield RepoAST.renderIndex(ast.commits, indexHead, ast.index);
        }
        const tree = exports.buildDirectoryTree(flatTree);
        const trees = yield writeCommitTrees(repo, [tree], commitMap);
        const treeId = trees[0];
        const index = yield repo.index();
        const treeObj = yield repo.getTree(treeId);
        yield index.readTree(treeObj);
        yield index.write();

        // TODO: Firgure out if this can be done with NodeGit; extend if
        // not.  I didn't see anything about `clean` and `Checkout.index`
        // didn't seem to work..

        const checkoutIndexStr = `\
git -C '${repo.workdir()}' clean -f -d
git -C '${repo.workdir()}' checkout-index -a -f
`;
        yield exec(checkoutIndexStr);

        // Now apply changes to the workdir.

        const workdir = ast.workdir;
        for (let filePath in workdir) {
            const change = workdir[filePath];
            const absPath = path.join(repo.workdir(), filePath);
            if (null === change) {
                yield fs.unlink(absPath);
            }
            else {
                const dirname = path.dirname(absPath);
                mkdirp.sync(dirname);
                yield fs.writeFile(absPath, change);
            }
        }
    }

    return repo;
});

                          // End modue-local methods

/**
 * Return an array of arrays of commit shas such that the trees of the commits
 * identified in an array depend only on the commits in previous arrays.  The
 * tree of one commit depends on another commit (i.e., cannot be created until
 * that commit exists) if it has a submodule sha referencing that commit.
 * Until the commit is created, we do not know what its actual sha will be.
 *
 * @param {Object} commits map from sha to `RepoAST.Commit`.
 * @return {[[]] array or arrays of shas
 */
exports.levelizeCommitTrees = function (commits, shas) {
    assert.isObject(commits);
    assert.isArray(shas);

    const includedShas = new Set(shas);

    let result = [];
    const commitLevels = {};  // from sha to number

    function computeCommitLevel(sha) {
        if (sha in commitLevels) {
            return commitLevels[sha];
        }
        const commit = commits[sha];
        const changes = commit.changes;
        let level = 0;

        // If this commit has a change that references another commit via a
        // submodule sha, it must have a level at least one greater than that
        // commit, if it is also in the set of shas being levelized.

        for (let path in changes) {
            const change = changes[path];
            if (change instanceof RepoAST.Submodule) {
                if (includedShas.has(change.sha)) {
                    level = Math.max(computeCommitLevel(change.sha) + 1,
                                     level);
                }
            }
        }

        // Similarly, with parents, a commit's level must be greater than that
        // of parents that are included.

        const parents = commit.parents;
        for (let i = 0; i < parents.length; ++i) {
            const parent = parents[i];
            if (includedShas.has(parent)) {
                level = Math.max(level, computeCommitLevel(parent));
            }
        }
        commitLevels[sha] = level;
        if (result.length === level) {
            result.push([]);
        }
        result[level].push(sha);
        return level;
    }

    for (let i = 0; i < shas.length; ++i) {
        computeCommitLevel(shas[i]);
    }

    return result;
};

/**
 * Return a nested tree mapping the flat structure in the specified `flatTree`,
 * which consists of a map of paths to values, into a hierarchical structure
 * beginning at the root.  For example, if the input is:
 *     { "a/b/c": 2, "a/b/d": 3}
 * the output will be:
 *     { a : { b: { c: 2, d: 3} } }
 *
 * If `flatTree` contains submodules, render an appropriate `.gitmodules` file.
 *
 * @param {Object} flatTree
 * @return {Object}
 */
exports.buildDirectoryTree = function (flatTree) {
    let result = {};
    let gitModulesData = "";

    for (let path in flatTree) {
        const paths = path.split("/");
        let tree = result;

        // Navigate/build the tree until there is only one path left in paths,
        // then write the entry.

        for (let i = 0; i + 1 < paths.length; ++i) {
            const nextPath = paths[i];
            if (nextPath in tree) {
                tree = tree[nextPath];
                assert.isObject(tree, `for path ${path}`);
            }
            else {
                const nextTree = {};
                tree[nextPath] = nextTree;
                tree = nextTree;
            }
        }
        const leafPath = paths[paths.length - 1];
        assert.notProperty(tree, leafPath, `duplicate entry for ${path}`);
        const data = flatTree[path];
        tree[leafPath] = data;
        if (data instanceof RepoAST.Submodule) {
            const modulesStr = `\
[submodule "${path}"]
\tpath = ${path}
\turl = ${data.url}
`;
            gitModulesData += modulesStr;
        }
    }

    assert.notProperty(result,
                       SubmoduleConfigUtil.modulesFileName,
                       "no explicit changes to the git modules file");
    if ("" !== gitModulesData) {
        result[SubmoduleConfigUtil.modulesFileName] = gitModulesData;
    }

    return result;
};

/**
 * Create a repository having the state described by the specified `ast` to the
 * specified `path`.  Return the newly created repository and a map from the
 * commit IDs in `ast` to the actual commit IDs created.  The behavior is
 * undefined if `ast` specifies any open submodules.
 *
 * @async
 * @param {RepoAST} ast
 * @param {String}  path
 * @return {Object}
 * @return {NodeGit.Repository} return.repo
 * @return {Object}             return.commitMap map from new ID to input ID
 * @return {Object}             return.oldCommitMap  from input ID to new ID
 */
exports.writeRAST = co.wrap(function *(ast, path) {
    // TODO: just doing basic operations as needed, known not done:
    // 1. merge commits (i.e., with multiple parents)

    assert.instanceOf(ast, RepoAST);
    assert.isString(path);
    assert.deepEqual(ast.openSubmodules, {}, "open submodules not supported");

    const repo = yield NodeGit.Repository.init(path, ast.bare ? 1 : 0);

    yield configRepo(repo);

    const commits = yield writeAllCommits(repo, ast.commits);
    const resultRepo = yield configureRepo(repo, ast, commits.oldToNew);

    return {
        repo: resultRepo,
        commitMap: commits.newToOld,
        oldCommitMap: commits.oldToNew,
    };
});

/**
 * Write the repositories described in the specified `repos` map to a the
 * specified `rootDirectory`.  Return a map from repo name to
 * `NodeGit.Repository` objects, a map from the newly-generated commit IDs to
 * the original IDs in the ASTs, and a map from repo urls to their names.
 *
 * @async
 * @param {Object} repos
 * @param {String} rootDirectory
 * @return {Object}
 * @return {Object} return.repos        map from name to `NodeGit.Repository`
 * @return {Object} return.commitMap    map from new to old commit IDs
 * @return {Object} return.reverseCommitMap   map from old to new commit IDs
 * @return {Object} return.urlMap       map from new url to old name
 * @return {Object} return.reverseUrlMap map from old url to new name
 */
exports.writeMultiRAST = co.wrap(function *(repos, rootDirectory) {
    // This operation is complicated by the need to have a single commit ID
    // universe.  To make it work, we will use foul trickery:
    //   - create a single "commit" repo to which we will write all commits
    //   - when writing the actual repos, start them out as clones from the
    //     commit repo
    //   - but immediately remove the origin
    //   - then set up branches, remotes, HEAD, etc. as usual.

    assert.isObject(repos);
    assert.isString(rootDirectory);

    rootDirectory = yield fs.realpath(rootDirectory);

    repos = Object.assign({}, repos);  // make a copy

    // create a path for each repo

    let repoPaths = {};
    let urlMap = {};
    for (let repoName in repos) {
        const repoPath = path.join(rootDirectory, repoName, "/");
        repoPaths[repoName] = repoPath;
        urlMap[repoPath] = repoName;
    }

    // Now, rewrite all the repo ASTs to have the right urls.
    for (let repoName in repos) {
        const repoAST = repos[repoName];
        repos[repoName] =
                         RepoASTUtil.mapCommitsAndUrls(repoAST, {}, repoPaths);
    }

    // First, collect all the commits:

    let commits = {};
    for (let repoName in repos) {
        const repo = repos[repoName];
        Object.assign(commits, repo.commits);

        // Also, commits from open submodules.

        for (let subName in repo.openSubmodules) {
            Object.assign(commits, repo.openSubmodules[subName].commits);
        }
    }

    const commitRepoPath = yield TestUtil.makeTempDir();
    const commitRepo = yield NodeGit.Repository.init(commitRepoPath, 0);

    // Write them:

    const commitMaps = yield writeAllCommits(commitRepo, commits);

    // We make a ref for each commit so that it is pulled down correctly.

    for (let id in commits) {
        const newSha = commitMaps.oldToNew[id];
        const newId = NodeGit.Oid.fromString(newSha);
        const name = "refs/heads/" + id;
        yield NodeGit.Reference.create(commitRepo, name, newId, 0, "made ref");
    }

    /**
     * Configure the specified `repo` to have the value of the specified `ast`.
     * The behavior is undefined unless `repo` is a clone of the commit repo.
     *
     * @async
     * @param {NodeGit.Repository} repo
     * @param {RepoAST}            ast
     */

    const writeRepo = co.wrap(function *(repo, ast) {
        assert.instanceOf(ast, RepoAST);

        // Now we should have all the commits from `commitRepo` so delete it
        // and all associated refs.  We have to detach the head or it keeps
        // around the current branch.

        repo.detachHead();

        const refs = yield repo.getReferences(NodeGit.Reference.TYPE.LISTALL);
        for (let i = 0; i < refs.length; ++i) {
            NodeGit.Branch.delete(refs[i]);
        }
        yield NodeGit.Remote.delete(repo, "origin");

        // Then set up the rest of the repository.
        yield configureRepo(repo, ast, commitMaps.oldToNew);
        const cleanupString = `\
git -C '${repo.path()}' -c gc.reflogExpire=0 -c gc.reflogExpireUnreachable=0 \
-c gc.rerereresolved=0 -c gc.rerereunresolved=0 \
-c gc.pruneExpire=now gc`;
        yield exec(cleanupString);
    });

    // Now generate the actual repos.

    let resultRepos = {};
    for (let repoName in repos) {
        const ast = repos[repoName];
        const repoPath = repoPaths[repoName];
        const repo = yield NodeGit.Clone.clone(commitRepo.workdir(),
                                               repoPath, {
            bare: ast.bare ? 1 : 0
        });
        yield configRepo(repo);
        yield writeRepo(repo, ast, repoPath);
        resultRepos[repoName] = repo;

        let index = null;

        // If the base repo has a remote, read its url.

        const remotes = ast.remotes;
        let originUrl = null;
        if ("origin" in remotes) {
            originUrl = remotes.origin.url;
        }

        // Render open submodules.

        for (let subName in ast.openSubmodules) {

            if (null === index) {
                index =
                   yield RepoAST.renderIndex(ast.commits, ast.head, ast.index);
            }
            const sub = index[subName];
            const openSubAST = ast.openSubmodules[subName];

            const subRepo = yield SubmoduleConfigUtil.initSubmoduleAndRepo(
                                                                originUrl,
                                                                repo,
                                                                subName,
                                                                sub.url);
            // Pull in commits from the commits repo, but remove the remote
            // when done.

            yield NodeGit.Remote.create(subRepo,
                                        "commits",
                                        commitRepo.workdir());
            yield subRepo.fetchAll();
            yield NodeGit.Remote.delete(subRepo, "commits");

            yield writeRepo(subRepo, openSubAST);
        }
    }
    const reverseUrlMap = {};
    Object.keys(urlMap).forEach(url => {
        reverseUrlMap[urlMap[url]] = url;
    });
    return {
        repos: resultRepos,
        commitMap: commitMaps.newToOld,
        reverseCommitMap: commitMaps.oldToNew,
        urlMap: urlMap,
        reverseUrlMap: reverseUrlMap,
    };
});

