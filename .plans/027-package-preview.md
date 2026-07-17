# 027 package preview

status: complete

## goal
add pi.dev gallery preview media for `pi-async-compaction`, matching the branchout package pattern.

## subtasks
- [x] inspect branchout preview metadata/media pattern
- [x] create `media/social-preview.png`
- [x] add `pi.image` metadata and include media in npm package files
- [x] update README demo section to reference the preview
- [x] verify package metadata/pack contents

## assumptions
- use a static PNG preview, not video/gif
- host via raw GitHub URL from `main`, same as branchout
- no runtime extension code changes
