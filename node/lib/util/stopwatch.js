/*
 *
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

const assert = require("chai").assert;

/**
 * This module provides the `Stopwatch` class.
 */

/**
 * `Stopwatch` is a mechanism class providing a way to measure elapsed wall
 * time.
 */
class Stopwatch {

    /**
     * Create a new `Stopwatch` class; call `start` unles the specified
     * `paused` is true.
     *
     * @param {Boolean} paused
     */
    constructor(paused) {
        this.d_elapsed = 0;
        this.d_startTime = null;

        if (!paused) {
            this.start();
        }
    }

    /**
     * Start accumulating elapsed time.  The behavior is undefined unless
     * `!this.started`.
     */
    start() {
        assert(!this.started, "already started");
        this.d_startTime = new Date();
    }

    /**
     * Stop accumulating time and return the amount of time accumulated since
     * `this.start()` was called, in seconds.  The behavior is undefined
     * unless `this.started`.
     *
     * @return {Number}
     */
    stop() {
        assert(this.started, "not started");
        const current = this.getCurrentMs();
        this.d_elapsed += current;
        this.d_startTime = null;
        return this.elapsed;
    }

    /**
     * Stop accumulating time if accumulating, reset accumulated time to 0, and
     * return the amount of time accumulated until now, in seconds.  If the
     * specified `paused` is true, do not start the clock.
     *
     * @param {Boolean} [paused]
     * @return {Number}
     */
    reset(paused) {
        const current = this.elapsed;
        this.d_elapsed = 0;
        this.d_startTime = null;
        if (!paused) {
            this.start();
        }
        return current;
    }

    /**
     * Return the amount of time elapased since `start` was called, in
     * seconds.  The behavior is undefined unless `this.started`.
     *
     * @return {Number}
     */
    getCurrent() {
        assert(this.started);
        return this.getCurrentMs() / 1000.0;
    }

    /**
     * the amount of time elapased since `start` was called, in milliseconds.
     * The behavior is undefined unless `this.started`.
     *
     * @return {Number}
     */
    getCurrentMs() {
        assert(this.started);
        return (new Date()) - this.d_startTime;
    }

    /**
     * total amount of time accumualated in milliseconds
     * @property {Number} 
     */
    get elapsed() {
        return this.elapsedMs / 1000.0;
    }

    /**
     * total amount of time accumulated in seconds
     * @property {Number}
     */
    get elapsedMs() {
        if (null !== this.d_startTime) {
            return this.d_elapsed + this.getCurrentMs();
        }
        return this.d_elapsed;
    }

    /**
     * true if currently accumulating time and false otherwise
     * @property {Boolean}
     */
    get started() {
        return null !== this.d_startTime;
    }
}

module.exports = Stopwatch;
