#!/usr/bin/env -S python3 -I -B
"""Renders PROMPT.md for one run.

    ./prompt.py <run-dir>        prints the prompt

{RUN} is the run's absolute path, {TASK} the task's TASK.md (the task is read back from the run's
name, <task>-<cond>-<rep>), and {SKILLS} a listing of the skills installed in the run's
node_modules/hopgraph/skills/*/SKILL.md: one line per skill with the `name` and `description` of
its frontmatter and the path to its SKILL.md. With no skill installed (conditions A and B) the
{SKILLS} line and the blank line after it are removed, so A and B get the same prompt.
"""
import glob
import os
import re
import sys

E = os.path.dirname(os.path.abspath(__file__))


def frontmatter(path):
    text = open(path).read()
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    meta = {}
    if m:
        for line in m.group(1).splitlines():
            k, sep, v = line.partition(":")
            if sep and not line.startswith((" ", "\t")):
                meta[k.strip()] = v.strip().strip("\"'")
    return meta


def skills_block(run):
    lines = []
    for skill_md in sorted(glob.glob(os.path.join(run, "node_modules", "hopgraph", "skills", "*", "SKILL.md"))):
        meta = frontmatter(skill_md)
        name = meta.get("name") or os.path.basename(os.path.dirname(skill_md))
        desc = meta.get("description", "").strip()
        lines.append(f"- {name}: {desc} ({skill_md})" if desc else f"- {name} ({skill_md})")
    if not lines:
        return ""
    return "Skills available in this project (read a skill's SKILL.md before you work on what it covers):\n" + "\n".join(lines)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    run = os.path.abspath(sys.argv[1])
    name = os.path.basename(run)
    task = name.rsplit("-", 2)[0]
    task_md = os.path.join(E, "tasks", task, "TASK.md")
    if not os.path.exists(task_md):
        sys.exit(f"prompt.py: cannot tell the task of {name}")
    template = open(os.path.join(E, "PROMPT.md")).read().split("\n---\n", 1)[1].lstrip("\n")
    skills = skills_block(run)
    if skills:
        template = template.replace("{SKILLS}", skills)
    else:
        template = template.replace("{SKILLS}\n\n", "")
    prompt = template.replace("{RUN}", run).replace("{TASK}", open(task_md).read().rstrip("\n"))
    sys.stdout.write(prompt.rstrip("\n") + "\n")


if __name__ == "__main__":
    main()
