---
name: dsh-superagent-feishu-publish
description: Publish a Markdown file as a Feishu document that anyone with the link can read, and rebuild an existing one without changing its link.
---

Use `feishu_publish` when a person asks for a document that lives on the internet: a note, a release
record, a download or installation page, a tutorial. The tool takes a Markdown file, publishes it as a
Feishu document, makes it readable by anyone with the link, and returns the link.

A published document is public and cannot be un-published quietly. Before you publish, read the file and
decide whether it belongs on the internet. It does not if it holds a credential, an account name, a
password, an internal address, a private path, or a person's name that the person did not ask to publish.
The tool masks the shapes it knows — keys like `sk-…`, passwords, internal paths — but it cannot know
what is secret to this person. If a file mixes public prose and private facts, publish a version without
the private facts; write that version to a file first, and publish the file, not the original.

The tool prepares the Markdown for Feishu, and the preparation is worth knowing:
- frontmatter is dropped, so a title there never reaches the document;
- tables become lists, one line per cell, because a Feishu document has no table;
- fenced code blocks become indented code, and a `#` line inside code stays code;
- Obsidian wikilinks become plain words;
- the tail is dropped from the first heading of `## 四、代码与文档在哪`, `## 附：` or `## 相关`, which are the
  internal sections of a knowledge base.

Give `doc_id` to rebuild a document that already exists. The tool clears it and fills it again, so the
link stays the same and no second document is left behind. Use it whenever the source changed and the
person wants the link they already have to show the new text. Without `doc_id` every call creates a new
document. Only a document this tool published before may be rebuilt: an id from anywhere else is refused,
because rebuilding clears the document, and a document the tool did not create is not the tool's to clear.

The tool publishes only Markdown files, and only files inside the directories the profile is allowed to
publish from. A path outside them, or a file that is not Markdown, is refused. If the person names a file
that is refused, say so instead of looking for another way to publish it.

The document's owner becomes the personal account of the profile, so the document can be edited and
deleted in the Feishu interface afterwards, and the application cannot delete it.

Give `chat_id` to announce the document in a group. Only the groups the profile allows may be told; any
other group is refused, and a profile that allows no group is told nothing. The announcement is a message
with the title and the link.

The tool answers with the link, the document id, the title, the number of blocks and images, and the state
of the ownership. Give the person the link, and say what was published — the title and the file it came
from. If a publication fails, it says why: a missing credential, a document the application may not
write, an image that could not be uploaded.
