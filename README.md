<!--
    Copyright (c) 2016, Two Sigma Open Source
    All rights reserved.

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.

    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.

    * Neither the name of git-meta nor the names of its
      contributors may be used to endorse or promote products derived from
      this software without specific prior written permission.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
    AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
    IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
    ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
    LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
    CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
    SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
    INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
    CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
    ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
    POSSIBILITY OF SUCH DAMAGE.
-->

# Git-meta

**NOTE Git-meta is BETA software**: Git-meta is open for collaboration, but
currently in a very early phase of development.  We will be adding features and
addressing shortcomings as we can, but Git-meta is not officially supported by
Two Sigma at this time.

___Build a *mono-repo* -- a single repository of unbounded size -- using Git
submodules.___

In the first section of this document, we discuss the mono-repo.  We describe
key features and properties implied by the term, explain what makes
mono-repositories an attractive strategy for source code management, and also
why they are hard to implement, exploring some open source projects that are in
this space.  In short, the first section should explain why this problem is
worth solving and why there are no existing solutions.

The next section presents our architecture for implementing a mono-repo using
git submodules.  We describe the overall repository structure and
relationships, client- and server-specific concerns, and collaboration
strategies such as pull requests.

Finally, we discuss the tools provided by this project to support the proposed
architecture.  It is important to note that git-meta is built entirely on git:
it requires no extra servers, services, or databases and is not tied to any
specific git hosting solution.  There are two main sets of tools provided by
git-meta: programs intended to be run as server-side commit hooks to maintain
git-meta invariants and repository integrity; and a program intended to be used
as a git plugin on the client that simplifies interactions with submodules
(e.g., by providing a submodule-aware `merge` operation), and implements
other mono-repository aware functionality.

## Mono-repo

A mono-repo is a repository containing all of the source for an organization,
supporting atomic commits, branches, merges, etc. across all code.
