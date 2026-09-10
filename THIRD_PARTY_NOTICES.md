# Third-party notices

`dsh-mcp-lazy` is MIT licensed (see [LICENSE](LICENSE)). It is a derivative of two other
MIT-licensed projects, whose notices are reproduced below as their licenses require.

---

## @deepseek-ai/dsh-mcp-client

Copyright (c) 2026 DeepSeek

Licensed under the MIT License.

The connection supervisor, the transport factory, the environment-scrubbing rules, and the
settings-aware schema alignment in `src/` are derived from this package. It is the component
this plugin is a drop-in alternative to, and its config field names are kept deliberately
compatible so a profile can migrate by moving each row's `config` into one `servers` entry.

---

## pi-mcp-adapter

Copyright (c) Nico Bailon

Licensed under the MIT License.

The single-proxy-tool gateway, the persistent metadata cache, the four-mode server lifecycle,
the weighted search ranking, the output ceiling, and the failure backoff in `src/` are derived
from this project (<https://github.com/nicobailon/pi-mcp-adapter>). `docs/design/parity-pi-mcp-adapter.md`
records a module-by-module audit against v2.33.0, including the places where this plugin
deliberately differs.

---

## MIT License, as it applies to the two projects above

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
