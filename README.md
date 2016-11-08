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

**NOTE Git-meta is BETA software**: Git-meta is open for collaboration, but
currently in a very early phase of development.  We will be adding features and
addressing shortcomings as we can, but Git-meta is not officially supported by
Two Sigma at this time.

___Build a *mono-repo* -- a single repository of unbounded size -- using Git
submodules.___

# Overview

## What is git-meta?

Git-meta describes an architecture and provides a set of tools to facilitate
the implementation of a *mono-repo* and attendant workflows.

Aside from the ability to install the tools provided in this repository,
git-meta requires only Git.  Git-meta is not tied to any specific Git hosting
solution, and does not provide operations that are hosting-solution-specific,
such as the ability to create new (server-side) repositories.

## What is in the rest of this document?

In the first section of this document, we define the term *mono-repo*.  We
describe key features and properties of a mono-repo, explain what makes
mono-repos an attractive strategy for source code management, and also why they
are not found in most organizations, exploring some open source projects that
are in this space.  In short, the first section should explain why this problem
is worth solving and why there are no existing solutions.

The next section presents our architecture for implementing a mono-repo using
Git submodules.  We describe the overall repository structure, solutions to
collaboration problems, forking strategies, and server-side validations.

Finally, we discuss the two types of tools provided by this project to support
the proposed architecture: programs intended to be run as server-side commit
hooks to maintain git-meta invariants and repository integrity; and a program
intended to be used as a Git plugin on the client that simplifies interactions
with submodules (e.g., by providing a submodule-aware `merge` operation), and
implements other mono-repo-aware functionality.

# Mono-repo

## What is a mono-repo?

A mono-repo is a repository containing all of the source for an organization.
It presents source in a single, hierarchical directory structure. A mono-repo
supports standard operations such as atomic commits and merges across the code
it contains.

Critically, in order to host all source for an organization, the performance of
a mono-repo must not degrade as it grows in terms of:

- history (number of commits)
- amount of code (number of files and bytes)
- number of developers

## What are the advantages of a mono-repo?

The alternative to a mono-repo is for an organization to decompose its source
into multiple repositories.  In comparison to a multi-repo strategy,
a mono-repo provides the following advantages:

- Atomic changes can be made across the organization's code.
- The history of the of an organization's source is described in a mono-repo.
  With multiple repositories, it is impossible to present a unified history.
- Because all source is described in one history, archaeological operations such
  as `bisect` are easily supported.
- Source in the organization is easy to find.
- The use of a mono-repo encourages an organization to standardize on tools,
  e.g.: build and test.  When an organization has unrelated repositories that
  integrate at the binary level, its teams are more likely to adopt divergent
  build and test tools.
- The use of a mono-repo makes it easier to validate cross-organization builds
  and tests.

To summarize, the use of a single (mono) repository encourages collaboration
across an organization.  The use of multiple, unrelated, team-oriented
repositories encourages the use of divergent tooling and silos.

## Why doesn't everyone have a mono-repo?

Most organizations do not have a mono-repo because existing DVCS systems (e.g.,
Git and Mercurial) suffer performance degradation as the size of the repository
and the number of users increase.  Over time, basic operations such as `git
status`, `git fetch`, etc. become slow enough that developers, given the
opportunity, will begin splitting code into multiple repositories.

We discuss the architecture of git-meta in more detail in the next section, but
essentially it provides a way to use standard Git operations across many
repositories.  Before starting on git-meta, we did investigate several existing
products that take a similar approach:

- [Gitslave](http://gitslave.sourceforge.net)
- [myrepos](https://myrepos.branchable.com)
- [Android Repo](https://source.android.com/source/using-repo.html)
- [gclient](http://dev.chromium.org/developers/how-tos/depottools#TOC-gclient)
- [Git subtrees](https://git-scm.com/book/en/v1/Git-Tools-Subtree-Merging)
- [Git submodules](https://git-scm.com/docs/git-submodule)

All of these tools overlap with the problems git-meta is trying to solve, but
none of them are sufficient:

- most don't provide a way to reference the state of all repositories
  (Gitslave, Android Repo, Myrepos)
- some require a custom server (Android Repo)
- many are strongly focused on supporting a specific software platform (Android
  Repo, gclient)
- doesn't fully solve the scaling issue (Git subtrees)
- prohibitively difficult to use (Git submodules)
- lack scalable collaboration (e.g., pull request) strategies

Git submodules come the closest: they do provide the technical ability to solve
the problem, but are very difficult to use and lack some of the desired
features.  With git-meta, we build on top of Git submodules to provide the
desired functionality leveraging existing Git commands.

## Git-meta Architecture

In this section, we first provide an overview of the mono-repo. We describe its
structure, basic concerns such as commits, and performance.  Next, we discuss
forking.  Then, we describe *synthetic-meta-refs* and the problems they solve.
Finally, we describe integrity validations that must be performed in
server-side checks.

### Overview

#### Structure -- the meta-repo

Git-meta creates a logical mono-repo out of multiple *sub-repositories* (a.k.a.
sub-repo) by tying them together in a *meta-repository* (a.k.a. meta-repo) with
Git submodules.  Recall that a Git submodule consists of the following:

1. a path at which to root the submodule in the referencing (meta) repository
1. the url of the referenced (sub) repository
1. the id of the "current" commit in the referenced (sub) repository

Thus, a meta-repo presents the entire source structure in a rooted directory
tree, and the state of the meta-repo unambiguously describes the complete
state of all sub-repos, i.e., the mono-repo:

```
'------------------------------------------------------------------------`
|                                                                        |
|  '-----------------------`                                             |
|  | meta-repo  |          |                                             |
|  | *master =  | foo/bar--|---------> [a1   http://foo-bar.git]         |
|  | [m1]       | foo/baz--|---------> [b1   http://foo-baz.git]         |
|  |            |     zam--|---------> [c1   http://zam.git]             |
|  |            |          |                                             |
|  `-----------------------,                                             |
|                                                                        |
`------------------------------------------------------------------------,
```

This meta-repo, for instance, has the `master` branched checked out on commit
`m1`.  It references three sub-repos, rooted at: `foo/bar`, `foo/baz`, and
`zam`.  The sub-repo rooted at `foo/bar` lives in the url "http://foo-bar.git",
and is currently on commit `a1`.  In future diagrams we'll use a more compact
representation:

```
'---------------------------`
| meta-repo  |              |
| *master    | foo/bar [a1] |
| [m1]       | foo/baz [b1] |
|            |     zam [c1] |
|            |              |
`---------------------------,
```

Note that git-meta allows users to put arbitrary files in the meta-repo (e.g.,
global configuration data), but for simplicity we ignore them in the rest of
this document.

#### Commits

Commits in sub-repos do not directly affect the state of the mono-repo.
Updating the mono-repo requires at least two commits: (1) a commit in one or
more sub-repos and (2) a commit in the meta-repo.  Say, for example, that we
make changes to the `foo/bar` and `foo/baz` repositories, updating their HEADs
to point to `a2` and `b2`, respectively.

Our mono-repo has not yet been affected, and if you were to make a clone of the
meta-repo in this condition, you would see the same state diagrammed
previously.  To update the mono-repo, a commit must be made in the meta-repo,
changing the mono-repo to look like, e.g.:

```
'-------------------------------`
| meta-repo  |                  |
| *master    | foo/bar [a2->a1] |
| [m2->m1]   | foo/baz [b2->b1] |
|            |     zam [c1]     |
|            |                  |
`-------------------------------,
```

#### Refs

Only branches (and other refs, like tags) in the meta-repos are considered
significant to git-meta.  Users may create arbitrary branches in sub-repos, but
they are generally ignored by git-meta commands and workflows.

Git-meta itself creates and utilizes a special type of ref, called a
*syntetic-meta-ref* in sub-repos; we describe these in detail later.

#### Cloning, client-side representation

Users create local clones of a mono-repo by cloning the url of its meta-repo.
All sub-repos are *closed* by default.  When the user *opens* a sub-repo, it is
cloned and checked out.  Thus an initial clone requires downloading only
meta-information.  Subsequently, users need open only the sub-repos they need;
typically a small fraction of the organization's code.

#### Performance

At a minimum, users working in a mono-repo must download the meta-repo and all
sub-repos containing code that they require to work.

There is a commit in the meta-repo for every change made in the organization,
so the number of commits in the history of the meta-repo may be very large.
However, the information contained in each commit is relatively small,
generally indicating only changes to submodule pointers.  Furthermore, the
on-disk (checked out) rendering of the meta-repo is also small, being only a
file indicating the state of each sub-repo, and growing only as sub-repos are
added.  Therefore, the cost of cloning and checking out a meta-repo will be
relatively cheap, and scale slowly with the addition of new code -- especially
compared with the cost of doing the same operations in a single (physical)
repository.

Most other operations such as `checkout`, `commit`, `merge`, `status`, etc.
increase in cost with the number of files in open repositories on disk.
Therefore, the performance of a mono-repo will generally be determined by how
many files developers need to have on disk to do their work; this number can be
minimized through several strategies:

- decomposing large large sub-repos into multiple sub-repos as they become
  overly large
- minimizing dependencies -- if an organization's software is a giant
  interdependent ball, its developers may need most of its code on disk to work
- eliminate the need to open dependent sub-repos -- typically, a developer
  needs to open sub-repos that the need to (a) change, or (b) are build
  dependencies of sub-repos they need to change.  While outside the scope of
  git-meta, we are developing a proposal to address this case and will link to
  it here when ready.

### Forking

It is possible to use git-meta with a single meta-repo namespace, but we
strongly recommend the use of a name-partitioning strategy, a.k.a. forking.
Forking may be generally be implemented either via [Git
namespaces](https://git-scm.com/docs/gitnamespaces) or a
hosting-solution-specific forking mechanism.  Without forking, every user will
receive every branch in existence on every fetch/clone, causing significant
performance problems, especially over time.

We fork only the meta-repo.  That is, for a given mono-repo, there may be any
number of peer forks of the meta-repo on the back-end (though policy will
generally designate that some meta-repos are special), but only one instance of
each sub-repo:

```
'-----------` '-----------`
|     a     | |     b     |
`-----------, `-----------,
   ^     ^      ^      ^
   |     |     /       |
   |     |    /        |
   |      `--.---.     |
   |     .--/    |     |
'--|-----|--` '--|-----|--`
|  a     b  | |  a     b  |
| - - - - - | | - - - - - |
| jill/meta | | bill/meta |
`-----------, `-----------,
```

Any clone of any meta-repo (even a local one) will still reference the same
canonical sub-repos.  Thus, a mono-repo is not truly distributed like single
Git repositories.  We consider this to be acceptable for the following reasons:

- Mono-repos are designed to facilitate source management in large
  organizations, which generally nominate canonical repositories for
  integration anyway.
- The individual repos of which they are composed are still normal,
  distributed, Git repos (e.g., two distinct mono-repos may contain sub-repos
  with the same histories).
- As will be described in the next section on synthetic-meta-refs, workflows
  involving forked sub-repos have significant drawbacks.
- One of the main benefits of DVCSs -- the ability to have a first-class
  development experience without network connectivity to the server -- is still
  possible, as we explain in the section on "Offline Workflows".

### Synthetic-Meta-Refs

In this section, we describe our original (naive) branch collaboration strategy
and some problems it created.  Then we describe the *synthetic-meta-ref*, and
show how it provides a solution to the these collaboration problems.  Finally,
we explore the ramifications of our synthetic-meta-ref strategy on tooling,
performance, and offline workflows.

#### Naive Collaboration Strategy

Our original collaboration strategy was simple; we attempted to mirror the
normal, de-centralized model of Git as closely as possible:

The meta-repo and open sub-repos would generally be on the same checked-out
branch.

```
local
'-----------------------------`
| meta-repo  |                |
| *master    | a *master [a1] |
| [m1]       | b *master [b1] |
`-----------------------------,
```

When pushing a ref, we would first push the ref with that name from open
sub-repos, then from the meta-repo.

```
local
'---------------------------------`
| meta-repo  |                    |
| *master    | a *master [a2->a1] |
| [m2->m1]   | b *master [b2->b1] |
`---------------------------------,

remote
'---------------------`  '--------`  '--------`
| meta-repo  |        |  | a      |  | b      |
| master     | a [a1] |  | master |  | master |
| [m1]       | b [b2] |  | [a1]   |  | [b1]   |
`---------------------,  `--------,  `--------,
```

```bash
$ cd meta-repo
$ cd a
$ git push origin master
$ cd ../b
$ git push origin master
$ cd ..
$ git push origin master
```

When landing pull-requests or doing other server-side validations, we would
check that for a given meta-repo branch, we had corresponding valid sub-repo
branches of the same name.

```
local
'---------------------------------`
| meta-repo  |                    |
| master     | a *master [a2->a1] |
| [m2->m1]   | b *master [b2->b1] |
`---------------------------------,

remote
'---------------------`  '--------`  '--------`
| meta-repo  |        |  | a      |  | b      |
| master     | a [a1] |  | master |  | master |
| [m1]       | b [b2] |  | [a1]   |  | [b1]   |
`---------------------,  `--------,  `--------,
```

```bash
$ cd meta-repo
$ git push origin master
error: master ref in sub-repo a does not point to commit a2
error: master ref in sub-repo b does not point to commit b2
```

Sub-repo forking would follow meta-repo forking.  We created the term *orchard*
to describe a meta-repo and its associated collection of sub-repo forks.  When
a user "forked" an orchard, it would create a new, _peer_ orchard, modeling the
peer-to-peer aspects of normal Git repositories.  A project named "foo" might
have an orchard configured as:

```
'---------------------`  '--------`  '--------`
| foo/meta-repo       |  | foo/a  |  | foo/b  |
| master     | a [a1] |  | master |  | master |
| [m1]       | b [b2] |  | [a1]   |  | [b1]   |
`---------------------,  `--------,  `--------,
```

If Jill were to fork foo, the result would be:

```
'---------------------`  '--------`  '--------`
| jill/meta-repo      |  | jill/a |  | jill/b |
| master     | a [a1] |  | master |  | master |
| [m1]       | b [b2] |  | [a1]   |  | [b1]   |
`---------------------,  `--------,  `--------,
```

Unfortunately, while this model was intuitive, it created several intractable
problems:

##### Race conditions on collaboration branches

Git does not provide for atomic cross-repository operations.  So, as described
above, our plan had been to implement push such that we updated affected
sub-repo branches first, then the meta-repo branch.  Furthermore, we would
provide server-side validation to reject attempts to update a meta-repo branch
to a commit contradicting the state of the corresponding sub-repo branch.

Unfortunately, this strategy suffers from a potential race condition that could
put a branch in the meta-repo into a state such that it could no longer be
updated.  For example, lets say Bob and Jill both have unrelated changes to
repos `a` and `b`:

```
Bob's local                       Jill's local
'-------------------------`       '-------------------------`
| meta-repo  |            |       | meta-repo  |            |
| master     | a [a2->a1] |       | master     | a [a3->a1] |
| [m2->m1]   | b [b2->b1] |       | [m3->m1]   | b [b3->b1] |
`-------------------------,       `-------------------------,

remote
'---------------------`  '--------`  '--------`
| meta-repo  |        |  | a      |  | b      |
| master     | a [a1] |  | master |  | master |
| [m1]       | b [b2] |  | [a1]   |  | [b1]   |
`---------------------,  `--------,  `--------,
```

If Bob pushes first, the result will be the state described in the previous
diagram.  If Jill pushes after Bob, her sub-repo pushes (neither of which are
fast-forwardable) will fail, and her meta-repo push will be rejected (though
her client should not attempt it anyway).  This is the expected scenario.  But
what if they go at the same time? Say that Bob's push to `a` and Jill's push to
`b` succeed, while Bob's push to `b`, and Jill's push to `a` fail:

```
Bob's local                       Jill's local
'-------------------------`       '-------------------------`
| meta-repo  |            |       | meta-repo  |            |
| master     | a [a2->a1] |       | master     | a [a3->a1] |
| [m2->m1]   | b [b2->b1] |       | [m3->m1]   | b [b3->b1] |
`-------------------------,       `-------------------------,

remote
'---------------------`  '----------`  '----------`
| meta-repo  |        |  | a        |  | b        |
| master     | a [a1] |  | master   |  | master   |
| [m2->m1]   | b [b2] |  | [a2->a1] |  | [b3->b1] |
`---------------------,  `----------,  `----------,
```

Now, the remote meta-repo is technically in a valid state: users can clone it
and checkout, and all is good.  However, neither Bob, nor Jill, nor anyone else
will be able to push a new change without addressing the situation by hand;
most likely, they will need an expert to rectify the situation.

We explored some options to address this, such as pushing branches in order,
but they all fell short.  In fact, this situation does not require a race: if a
user simply aborts the overall push after some sub-repo branches have been
updated but before the meta-repo has been, a similar state will be achieved.

##### Force Pushing

Force-pushing in sub-modules can easily cause meta-repo commits to become
invalid by making it impossible to fetch the sub-repo commits they reference,
and eventually allowing them to be garbage collected.  While we expect
"important" branches to be protected against force-pushing, it's a very common
and useful practice in general, even on branches used for collaboration.

```
'---------------------`  '----------`
| meta-repo  |        |  | a        |
| master     | a [a2] |  | master   |
| [m1]       |        |  | [a2->a1] |
`---------------------,  `----------,
```

```bash
git push -f a-origin a1:master
```

```
'---------------------`  '----------`
| meta-repo  |        |  | a        |
| master     | a [a2] |  | master   |
| [m1]       |        |  | [a1]     |
`---------------------,  `----------,
```

##### Fork Frenzy

Generating a new repository for each sub-repo when a forked orchard is created
could be expensive if the number of sub-repos is large.   Furthermore, what
happens when new sub-repos are added? Take the earlier example:

```
'---------------------`  '--------`  '--------`
| foo/meta-repo       |  | foo/a  |  | foo/b  |
| master     | a [a1] |  | master |  | master |
| [m1]       | b [b2] |  | [a1]   |  | [b1]   |
`---------------------,  `--------,  `--------,

'---------------------`  '--------`  '--------`
| jill/meta-repo      |  | jill/a |  | jill/b |
| master     | a [a1] |  | master |  | master |
| [m1]       | b [b2] |  | [a1]   |  | [b1]   |
`---------------------,  `--------,  `--------,
```

Now, if a new repository, `c`, is added we have:

```
'---------------------`  '--------`  '--------` '--------`
| foo/meta-repo       |  | foo/a  |  | foo/b  | | foo/c  |
| master     | a [a1] |  | master |  | master | | master |
| [m1]       | b [b2] |  | [a1]   |  | [b1]   | | [b1]   |
`---------------------,  `--------,  `--------, `--------,

'---------------------`  '--------`  '--------`
| jill/meta-repo      |  | jill/a |  | jill/b |
| master     | a [a1] |  | master |  | master |
| [m1]       | b [b2] |  | [a1]   |  | [b1]   |
`---------------------,  `--------,  `--------,
```

We could have an automated task that would detect the creation of new
repositories and auto-fork them, but when?  To allow for collaboration, we
would most likely need to perform the auto-fork whenever a new repository is
created, likely a very expensive operation for a potentially speculative
operation.  The existence of these forks could be confusing, at best, if the
when repositories are abandoned.  At the very least, we have created a new
concept -- a set of related orchards -- that undermines our peer-to-peer model.

##### Remote Frenzy

As is normal in Git, different forks are handled locally through remotes.  Bob,
for example, might have an origin for the "main" meta-repo and one for Jill's
fork.  The following diagram indicates that Bob has added Jill's fork under the
origin named "jill", and has pointed his checked-out `master` branch at the
same commit as her `master` branch: `j2`.

```
'-------------`
| meta-repo   |
| - - - - - - |
| origin      |
|   master    |
|    [m1]     |
| jill        |
|   master    |
|    [j2->m1] |
| - - - - - - |
| *master     |
|   [j2]      |
`-------------,
```

If Bob attempts to open the submodule `a` in the normal manner, he will get an
error such as:

```bash
$ cd meta
$ git submodule update --init a
fatal: reference is not a tree: j2
Unable to checkout 'j2' in submodule path
'a'
```

This error happens because the default behavior of `submodule update --init` is
to fetch refs from the url with which that submodule was created: there can be
only one such origin.  As will be seen later, working effectively with
submodules requires much tooling support, so we can easily add our own `open`
operation that will configure submodules with all known origins (and fetch them
all), e.g.:

```bash
$ git meta open a
```

```
'----------------------------`
| meta-repo   | a            |
| - - - - - - | - - - - - - -|
| origin      | origin       |
|   master    |  master      |
|    [m1]     |   [a1]       |
| jill        | jill         |
|   master    |  master      |
|    [j2->m1] |   [ja2->a1]  |
| - - - - - - | - - - - - -  |
| *master     | *master      |
|   [j2]      |   [ja2]      |
`----------------------------,
```

We would also need to add our own versions of commands for, e.g., adding,
removing, and fetching remotes that would add, remove, and fetch the same
remotes in open sub-repos.  Unfortunately, besides being complex, this solution
has serious drawbacks:

- Users may reasonably desire to manipulate remotes using straight Git,
  bypassing our tools, invalidating our invariants, and creating difficult to
  diagnose and repair situations.
- Developers will naturally add remotes for the forks of other developers that
  they collaborate with.  The requirement to fetch every remote in every
  sub-repo (even if done in parallel) could cause performance problems.
- Even using our tools as designed, developers may easily create invalid,
  difficult-to-recover-from situations.  For example, if a developer makes a
  local branch from a remote branch, then removes the remote from which that
  branch came, they may not be able to find the needed commits when opening
  sub-repos:

```
'-------------`
| meta-repo   |
| - - - - - - |
| origin      |
|   master    |
|    [m1]     |
| jill        |
|   master    |
|    [j2->m1] |
| - - - - - - |
| *master     |
|   [j2]      |
`-------------,
```

```bash
$ git meta remote rm jill
```

```
'-------------`
| meta-repo   |
| - - - - - - |
| origin      |
|   master    |
|    [m1]     |
| - - - - - - |
| *master     |
|   [j2]      |
`-------------,
```

Now even `git meta open` will be unable to initialize the submodule `a` because
Bob's `master` branch references a commit in it that cannot be found; we no
longer have any knowledge that Jill's fork exists.

#### Enter syntetic-meta-refs

In this section, we define the term *synthetic-meta-ref* and describe how
synthetic-meta-refs are used in our mono-repo ref strategy.  Then, we explain
how this strategy solves the collaboration problems discussed earlier.
Finally, we present to variations on our strategy that we did not use, but that
could prove useful and/or informative.

##### Definition

A synthetic-meta-ref is a ref in a sub-repo in a specific form, most notably
including the ID of the Git commit to which it points in its name, such as:
`refs/meta/929e8afc03fef8d64249ad189341a4e8889561d7`.  The term is derived
from the fact that such a ref is:

1. _synthetic_ -- generated by a tool
1. _meta_ -- identifying a commit in a sub-repo that is (directly or
   indirectly) referenced by a commit in the meta-repo
1. _ref_ -- just a ref, not a branch or tag




##### As fetch targets

As it is not possible to directly fetch a commit by its sha1 in earlier
versions of Git, our first proposal for synthetic-meta-refs had the invariant
that every commit in a sub-repo that is directly referenced by a commit in any
meta-repo fork have a synthetic-meta-ref associated with it.

This invariant would have been expensive to satisfy on the client.  We don't
generally know which commits have meta-refs associated with them, and even if
we did, there might be cases where we would genuinely need to create large
numbers of them: such as when importing an existing repository.

Some of the cost might have been reduced by generating the refs in server-side
hooks, but we have otherwise been able to restrict our server-side hooks to
read-only operations.

##### Mega-ref

Another strategy would be to maintain a *mega-ref* in each sub-repo.  The
mega-ref is a ref through which all the commits in a sub-repo identified by all
commits in all meta-repos can be reached.  Whenever a synthetic-meta-ref is
pushed to a sub-repo, the mega-ref is rewritten to have the commit identified
by the new synthetic-meta-ref if it does not already contain that commit in its
history.
