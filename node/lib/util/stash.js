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

const assert = require("chai").assert;

/**
 * @class
 * This class represents the state of a stashed submodule.
 */
class Submodule {

    /**
     * Create a new `Submodule` object having the specified `indexSha`, and
     * `workdirSha`.
     *
     * @param {String} indexSha          state of index
     * @param {String|null} untrackedSha tree refs untracked files
     * @param {String} workdirSha        tree is workdir state
     */
    constructor(indexSha, untrackedSha, workdirSha) {
        assert.isString(indexSha);
        if (null !== untrackedSha) {
            assert.isString(untrackedSha);
        }
        assert.isString(workdirSha);

        this.d_indexSha = indexSha;
        this.d_untrackedSha = untrackedSha;
        this.d_workdirSha = workdirSha;
        Object.freeze(this);
    }

    /**
     * the sha of the commit whose tree describes the stashed state of this
     * submodule's index
     * @property {String}
     */
    get indexSha() {
        return this.d_indexSha;
    }

    /**
     * the sha of the commit whose tree describes the untracked files in
     * this submodule
     * @property {String|null}
     */
    get untrackedSha() {
        return this.d_untrackedSha;
    }

    /**
     * the sha of the commit whose tree describes the stashed workdir of this
     * submodule
     * @property {String}
     */
    get workdirSha() {
        return this.d_workdirSha;
    }
}

/**
 * @class
 * This class represents the state of a stashed monorepo.
 */
class Stash {

    /**
     * Create a new `Stash` object having the specified `indexSha`,
     * `submodules`, `submodulesSha`, and `workdirSha`.
     *
     * @param {String} indexSha
     * @param {Object} submodules  from name to `Submodule`
     * @param {String} submodulesSha
     * @param {String} workdirSha
     */
    constructor(indexSha, submodules, submodulesSha, workdirSha) {
        assert.isString(indexSha);
        assert.isObject(submodules);
        assert.isString(submodulesSha);
        assert.isString(workdirSha);

        this.d_indexSha = indexSha;
        this.d_submodules = {};
        for (let name in submodules) {
            const sub = submodules[name];
            assert.instanceOf(sub, Submodule);
            this.d_submodules[name] = sub;
        }
        this.d_submodulesSha = submodulesSha;
        this.d_workdirSha = workdirSha;
        Object.freeze(this);
    }

    /**
     * sha of the commit reflecting the state of the index
     *
     * @property {String}
     */
    get indexSha() {
        return this.d_indexSha;
    }

    /**
     * map from name to `Submodule`
     *
     * @property {Object}
     */
    get submodules() {
        return Object.assign({}, this.d_submodules);
    }

    /**
     * sha of the commit mapping to the submodule shas
     *
     * @property {String}
     */
    get submodulesSha() {
        return this.d_submodulesSha;
    }

    /**
     * sha of the commit that reflects the workdir state
     *
     * @property {String}
     */
    get workdirSha() {
        return this.d_workdirSha;
    }
}

Stash.Submodule = Submodule;
module.exports = Stash;
