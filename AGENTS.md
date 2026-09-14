# dsh-mcp-lazy

## Agent 技能

技能全部住在 `~/.agents/skills/`，**全局会话自动可见，本仓库无需挂载**。

> 2026-09 变更：原先这里用软链指向技能库 `~/.agents/skills-src/`，由 `skill-link` 管理、逐个挂载。
> 该目录与那个工具都已移除，技能已合并进全局的 `~/.agents/skills/`；本仓库不再需要 `.agents/skills/`。

本仓库常用的：`code-review` `code-stats` `docker-image-optimize` `frontend-design` `repo-workflow` `resolving-merge-conflicts` `secrets-scanner` `setup-pre-commit` `tdd` `webapp-testing`

- 新增/修改技能：直接动 `~/.agents/skills/<名字>/`（目录名 = 技能名，写进去即生效，无需挂载）
- **只本仓库专用**的技能才放 `.agents/skills/<名字>/SKILL.md`（DSH 原生扫 `<项目根>/.agents/skills`，前提是仓库已 `git init`）
- 维护规则见 `~/.agents/skills/AGENTS.md`
