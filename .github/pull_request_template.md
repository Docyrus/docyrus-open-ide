## What changed

<!-- One or two sentences. What does this PR do? -->

## Why

<!-- The problem or issue this addresses. Link it: Closes #123 -->

## How I verified it

<!-- This app is hard to judge from a diff. Say what you actually ran and saw. -->

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run build` — **not run by CI**; required if this touches the build, `app.json`, or bridge commands
- [ ] Ran `npm run dev` and exercised the change in a real window

Steps you clicked through, and what you observed:

## Checklist

- [ ] I am a member of the Docyrus organization, or an issue was agreed on first
- [ ] Did not hand-edit `frontend/dist/tree.js` (it is generated from `frontend/tree.js`)
- [ ] New bridge commands are registered in `app.json`, `bridge_policies`, **and** `bridge_handlers`, with the existing guards
- [ ] No version bump in `package.json` / `app.json` unless this PR is the release

## Screenshots

<!-- For any UI change. Before and after if you can. -->
