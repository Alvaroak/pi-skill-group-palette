# @alvaroak/pi-skill-group-palette

Grouped skill palette and lazy skill-group discovery for the [Pi coding agent](https://github.com/earendil-works/pi).

Skills live on a "shelf" (`~/skills-shelf`) organised into group folders. Pi does **not** autodiscover the shelf — this extension owns discovery: only the groups you enable are ever scanned, so disabled skills cost zero tokens (no system-prompt block, no `/skill:name` command, nothing).

> Design inspired by [nicobailon/pi-skill-palette](https://github.com/nicobailon/pi-skill-palette) — this variant groups skills by shelf folder and controls *discovery itself* rather than just selection.

## Install

```bash
pi install git:github.com/Alvaroak/pi-skill-group-palette@v0.1.0
```

## Usage

```bash
/skillgroups              # open the palette overlay
/skillgroups list         # print group status
/skillgroups <name> on    # enable a group (re-scan, load its skills)
/skillgroups <name> off   # disable a group (re-scan, drop its skills)
```

In the overlay:

| Key | Action |
|---|---|
| `Tab` / `←→` | cycle to next/previous group (resets skill search) |
| `Enter` on tab bar | toggle that group on/off |
| type / `↑↓` | fuzzy-filter that group's skills |
| `Enter` in skill list | queue/unqueue the skill for your next message |
| `ctrl+t` in skill list | enable/disable the individual skill |
| `Esc` | close / back out |

Group toggles last for the session; per-skill toggles persist across sessions. Skills whose `SKILL.md` frontmatter declares `always-on: true` show with a ↻ marker — always active regardless of toggles.

## License

MIT
