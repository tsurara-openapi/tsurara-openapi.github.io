---
title: "Validation"
sourcePath: docs/guide/validation.md
sourceHash: 19a25cfc9f72
---

What tsurara checks, and what stays with you (design.md chapters 12 and 15).

## What tsurara checks

| Check | How |
|---|---|
| The generated files match the definition | `tsurara check` in CI: forgotten regeneration, hand edits |
| The generated code and the runtime fit together | `tsurara check` compares the version range the code records with the installed `@tsurara/client` |
| The definition is translated faithfully | Types are exact, wider (with the constraint in JSDoc), or the keyword is dropped with a warning ([Types](../types/)); `--strict` makes warnings errors |
| A response's status and media type match the definition | At run time: undocumented statuses are `http` results with `documented: false` (`onUndocumentedStatus` observes them); a body that is not what the definition says is a `parse` result |

## What tsurara does not check

- **That responses match their schemas, unless you ask.** By default JSON is parsed, not validated: the types say what the definition promises, not what the server sent. With `typescript.validators: zod` and `validate: validateResponses(responseSchemas)` the client checks types and formats and returns `kind: 'validation'` for bodies that do not match ([The client](../client/#validation)). Contract tests on the server still catch drift before it ships.
- **Constraints the types cannot express** (`pattern`, `minimum`, `maxLength`, ...), unless you ask. They are in JSDoc. With `typescript.validatorConstraints: true` the Zod schemas check them too (and the formats `uri`, `ipv4`, `ipv6`, `date`, `time`, `duration`), so they can validate form input; response validation then rejects values that break them. A `pattern` JavaScript cannot compile is left out with a warning. Requests are not validated before sending.
- **Forms.** Validating user input in a UI is a different job (messages, partial values, fields that the API does not have). Use a form library with its own schema; tsurara types are a good target for its output.
