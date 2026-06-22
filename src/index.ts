#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { lsCommand } from "./commands/ls";
import { add } from "./commands/add";
import { doCommand } from "./commands/do";
import { taskCommand } from "./commands/task";
import { projectCommand } from "./commands/project";
import { completionCommand } from "./commands/completion";
import { block } from "./commands/block";
import { eventCommand } from "./commands/event";
import { authCommand } from "./commands/auth";
import { cacheCommand } from "./commands/cache";
import { slotCommand } from "./commands/slot";
import { today } from "./commands/today";

const main = defineCommand({
  meta: {
    name: "af",
    description: "Akiflow CLI - Task management and automation",
    version: "0.2.0",
  },
  subCommands: {
    add,
    today,
    do: doCommand,
    ls: lsCommand,
    task: taskCommand,
    project: projectCommand,
    completion: completionCommand,
    block,
    event: eventCommand,
    auth: authCommand,
    cache: cacheCommand,
    slot: slotCommand,
  },
});

runMain(main);
