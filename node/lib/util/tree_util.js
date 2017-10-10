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
"use strict";

const assert  = require("chai").assert;
const co      = require("co");
const NodeGit = require("nodegit");
const path    = require("path");

const RepoStatus = require("./repo_status");

/**
 * Return a nested tree mapping the flat structure in the specified `flatTree`,
 * which consists of a map of paths to values, into a hierarchical structure
 * beginning at the root.  For example, if the input is:
 *     { "a/b/c": 2, "a/b/d": 3}
 * the output will be:
 *     { a : { b: { c: 2, d: 3} } }
 *
 * @param {Object} flatTree
 * @return {Object}
 */
exports.buildDirectoryTree = function (flatTree) {
    let result = {};

    for (let path in flatTree) {
        const paths = path.split("/");
        let tree = result;

        // Navigate/build the tree until there is only one path left in paths,
        // then write the entry.

        for (let i = 0; i + 1 < paths.length; ++i) {
            const nextPath = paths[i];
            const nextElement = tree[nextPath];

            // If The element exists or is a deletion, we can overwite it.
            // This can happen when a file is deleted that will turn into a
            // subdirectory.

            if (undefined !== nextElement && null !== nextElement) {
                tree = nextElement;
                assert.isObject(tree, `for path ${path}`);
            }
            else {
                const nextTree = {};
                tree[nextPath] = nextTree;
                tree = nextTree;
            }
        }
        const data = flatTree[path];
        const leafPath = paths[paths.length - 1];
        const existing = tree[leafPath];

        // If there is an existing element in `leafPath` in the tree and this
        // element is null, then it means something was deleted that is turning
        // into a directory.  If this item is not null, we have a bug.

        if (undefined !== existing) {
            assert(null === data, `duplicate entry for ${path}`);
        }
        else {
            tree[leafPath] = data;
        }
    }

   return result;
};

/**
 * `Change` is a value-semantic class representing a change to be registered
 * for path in a repository.
 */
class Change {

    /**
     * Create a new `Change` object having the specified object `id` and file
     * `mode`.
     *
     * @param {NodeGit.Oid}                id
     * @param {NodeGit.TreeEntry.FILEMODE} mode
     */
    constructor(id, mode) {
        this.d_id = id;
        this.d_mode = mode;
    }

    /**
     * @property {NodeGit.Oid}
     */
    get id() {
        return this.d_id;
    }

    /**
     * @property {NodeGit.TreeEntry.FILEMODE}
     */
    get mode() {
        return this.d_mode;
    }
}

exports.Change = Change;

/**
 * Return the tree created by applying the specified `changes` to the specified
 * `baseTree` (if provided) in the specified `repo`.  `changes` maps from path
 * to a change to write in the tree for that path, with a null entry indicating
 * that the path is to be removed.  The behavior is undefined if `null ===
 * baseTree` and any removals are specified in `changes`, if there are changes
 * specified that are not BLOB or COMMIT, or if there are conflicts between the
 * specified changes themselves or the base tree, such as:
 *
 * - removal for a path that doesn't exist
 * - a path change for an entry that logically must contain a tree
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Tree|null}  baseTree
 * @param {Object}             changes map from path to `Change`
 * @return {NodeGit.Tree}
 */
exports.writeTree = co.wrap(function *(repo, baseTree, changes) {
    assert.instanceOf(repo, NodeGit.Repository);
    if (null !== baseTree) {
        assert.instanceOf(baseTree, NodeGit.Tree);
    }
    assert.isObject(changes);

    // First, aggregate the flat mapping from path to change into a
    // hierarchical map.

    const directory = exports.buildDirectoryTree(changes);

    // This method does the real work, but assumes an already aggregated
    // directory structure.

    const writeSubtree = co.wrap(function *(parentTree, subDir) {
        // Put entries here to prevent collection; otherwise, they could be
        // free'd before they are used; see:
        // https://github.com/twosigma/git-meta/issues/373.

        const entries = [];
                        
        const builder = yield NodeGit.Treebuilder.create(repo, parentTree);
        for (let filename in subDir) {
            const entry = subDir[filename];

            if (null === entry) {
                // Null means the entry was deleted.

                builder.remove(filename);
            }
            else if (entry instanceof Change) {
                const e = yield builder.insert(filename, entry.id, entry.mode);
                entries.push(e);
            }
            else {
                let subtree;
                let treeEntry = null;
                if (null !== parentTree) {
                    try {
                        treeEntry = yield parentTree.entryByPath(filename);
                    }
                    catch (e) {
                        // 'filename' didn't exist in 'parentTree'
                    }
                }
                let subtreeParent = null;

                // If an tree exists at this spot, use it as a parent.
                // Otherwise, make a new one.

                if (null !== treeEntry && treeEntry.isTree()) {
                    const treeId = treeEntry.id();
                    subtreeParent = yield repo.getTree(treeId);
                }
                subtree = yield writeSubtree(subtreeParent, entry);
                if (0 === subtree.entryCount()) {
                    builder.remove(filename);
                }
                else {
                    const e = yield builder.insert(filename,
                                              subtree.id(),
                                              NodeGit.TreeEntry.FILEMODE.TREE);
                    entries.push(e);
                }
            }
        }
        const id = builder.write();
        return yield repo.getTree(id);
    });
    return yield writeSubtree(baseTree, directory);
});

/**
 * Return an blob ID for the specified `filename` in the specified `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             filename
 * @return {NodeGit.Oid}
 */
exports.hashFile = function (repo, filename) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(filename);

    // 'createFromDisk' is unfinished; instead of returning an id, it takes an
    // buffer and writes into it, unlike the rest of its brethern on `Blob`.
    // TODO: patch nodegit with corrected API.

    const placeholder =
            NodeGit.Oid.fromString("0000000000000000000000000000000000000000");
    const filepath = path.join(repo.workdir(), filename);
    NodeGit.Blob.createFromDisk(placeholder, repo, filepath);
    return placeholder;
};

/**
 * Return a map from path to `Change` for the working directory of the
 * specified `repo` having the specified `status`.  If the specified
 * `includeUnstaged` is true, include unstaged changes.
 *
 * @param {NodeGit.Repository} repo
 * @param {RepoStatus}         status
 * @param {Boolean}            includeUnstaged
 * @return {Object}
 */
exports.listWorkdirChanges = function (repo, status, includeUnstaged) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(status, RepoStatus);
    assert.isBoolean(includeUnstaged);

    const FILESTATUS = RepoStatus.FILESTATUS;
    const FILEMODE = NodeGit.TreeEntry.FILEMODE;

    const result = {};

    // first, plain files.

    const workdir = status.workdir;
    for (let path in workdir) {
        switch (workdir[path]) {
            case FILESTATUS.ADDED:
                if (includeUnstaged) {
                    result[path] = new Change(exports.hashFile(repo, path),
                                              FILEMODE.BLOB);
                }
                break;
            case FILESTATUS.MODIFIED:
                result[path] = new Change(exports.hashFile(repo, path),
                                          FILEMODE.BLOB);
                break;
            case FILESTATUS.REMOVED:
                result[path] = null;
                break;
        }
    }

    // then submodules; we're adding open submodules with different HEAD
    // commits.

    const submodules = status.submodules;
    for (let name in submodules) {
        const sub = submodules[name];
        const wd = sub.workdir;
        if (null !== wd &&
            RepoStatus.Submodule.COMMIT_RELATION.SAME !== wd.relation) {
            result[name] = new Change(
                                  NodeGit.Oid.fromString(wd.status.headCommit),
                                  FILEMODE.COMMIT);
        }
    }

    return result;
};
