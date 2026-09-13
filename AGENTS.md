# dsh-mcp-lazy

## Agent 技能

本仓库有项目级技能（DSH 的项目根 = 往上第一个含 `.git` 的目录，只扫 `<项目根>/.agents/skills`）。
`.agents/skills/` 里的条目是**软链**，指向技能库 `~/.agents/lib/`（改库里的原件，所有挂载点同时生效）。

已挂载：`code-review` `code-stats` `docker-image-optimize` `frontend-design` `repo-workflow` `resolving-merge-conflicts` `secrets-scanner` `setup-pre-commit` `tdd` `webapp-testing`

- 看/改挂载：`python3 ~/.agents/lib/skill-link linked` / `add <名字>` / `rm <名字>`
- 库里没有想要的技能：先找找 `python3 ~/.agents/lib/skill-link list`
- **技能的正确落点**：只本仓库用 → 挂这里；多个仓库都用 → 每个仓库各挂一次；不进仓库也要自动触发 → 才放全局 `~/.agents/skills/`。
- 新增技能先写在 `~/.agents/lib/_promote/`，写通了再用 `skill-link add` 决定归哪个仓库。

> 这些软链要跟着提交进 git：`git add .agents/skills && git commit -m "chore: 挂载技能"`
