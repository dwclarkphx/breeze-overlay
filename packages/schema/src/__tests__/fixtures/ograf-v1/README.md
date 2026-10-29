# OGraf v1 JSON Schemas (test fixtures)

Copied unmodified from the EBU's OGraf repository, `v1/specification/json-schemas/`,
at commit `164fb10bb361e249bc0cd915b0af3d6ed70083d8` (2026-10-04):
<https://github.com/ebu/ograf>.

`ograf.test.ts` validates the manifests Breeze generates (Phase 9 Wave D) against
them with Ajv, offline. Each file keeps its `$id`, so the `$ref`s between them
resolve exactly as they do at `ograf.ebu.io`.

Only the schemas the graphics manifest reaches are here: `graphics/schema.json`,
`lib/action.json`, `lib/constraints/*.json` and the GDD set `gdd/object.json`,
`gdd/gdd-types.json`, `gdd/basic-types.json`. To refresh them, copy the same files
from a newer commit and update the commit above.

These files are test data and are not part of anything Breeze ships.

## Licence

MIT License

Copyright (c) 2026 European Broadcasting Union (EBU)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
