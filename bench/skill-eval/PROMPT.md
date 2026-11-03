The prompt for an evaluated agent. `./prompt.py <run-dir>` renders it for a run; by hand, replace:

- `{RUN}` with the path new-run.sh printed;
- `{TASK}` with the contents of tasks/<task>/TASK.md;
- `{SKILLS}` with the skills listing in condition C, and with nothing in A and B (the line is
  then removed with its blank line, so A and B get the same prompt). prompt.py builds the listing
  from the SKILL.md files under the run's `node_modules/hopgraph/skills/`, as a harness injects
  skill metadata: one line per skill, its `name` and `description` from the frontmatter, and the
  path to its SKILL.md. For example:

  ```
  Skills available in this project (read a skill's SKILL.md before you work on what it covers):
  - hopgraph: <description> ({RUN}/node_modules/hopgraph/skills/hopgraph/SKILL.md)
  ```

Nothing else in it names the documentation, so what the agent reads is up to it. Everything below
the line is the prompt.

---

You are a developer on a small TypeScript service. The project is at {RUN}; work only there.

Rules for this session:
- Read and write files only inside {RUN}. Don't look at other directories, including parent
  directories.
- No network: don't install, update or download packages, and don't fetch web pages. Everything
  you need is in the project, including its installed dependencies under node_modules.
- Use `npm test` (vitest) and `npx tsc --noEmit` to check your work.
- Don't commit.
- When you're done, reply with a short summary of what you changed and why.

{SKILLS}

Here is your ticket:

{TASK}
