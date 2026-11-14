## What it does

- **Saves on its own**  
Your habits and preferences, lessons learned, project background and workflows are noted by the model as you chat, each marked as something you said explicitly or something the model observed or inferred. Every memory is a Markdown file stored per project; when one fits every project, the plugin suggests promoting it to a global memory.
- **Recalls when needed**  
A new chat starts with the core memories and an index already loaded. During the chat the model searches for more relevant memories as needed, and when necessary goes back to the conversation a memory came from.
- **Regular checkups**  
Checkups look for duplicates, contradictions, outdated and overly long memories within a project, and between project memories, global memories and `AGENTS.md`, then give a health score and suggestions. Run one by hand or schedule automatic checkups.
- **Always visible**  
When a chat adds or updates memories, a card appears under the reply so you can deal with them on the spot. The whale-tail icon below the input box shows memory usage and counts; the right sidebar shows the memories brought in at the start of this chat and the ones written along the way. Problems found by a checkup light up the Memory entry at the top left, which opens the page for reviewing and handling memories.
- **Your own setup**  
General, Coding and Office modes are built in, and you can define your own scenes and memory types, choosing what gets remembered and how. The injection budget, source lookup and health reminder sensitivity are all adjustable on the settings page.

## Design principles

- **Recording matters; upkeep matters more**  
Saving and searching are only part of long-term memory. Over time, duplicate, conflicting and outdated memories pile up and start to lead the model astray. Checking memory health, resolving contradictions and letting stale information go are just as much part of the job.
- **You make the key calls**  
The model proposes how to maintain and improve your memories, and nothing is carried out until you confirm. The model proposes and executes; the key decisions stay with you.
- **Every bit of your attention counts**  
Working with an agent comes down to where your attention goes. Most of the time the plugin and the model handle saving, searching and automatic checkups in the background without you. The cards in the chat start folded, and together with the right sidebar and the Memory entry at the top left they keep memory in view without breaking your flow, ready to expand and drill into whenever you want to look or step in. When a checkup finds problems, the items that need you are sorted by priority, so your effort goes to the decisions that matter most. As models get more capable, the plugin will take on more of the work and ask for confirmation less often.
- **Plastic memories**  
Everyone works with agents in their own way, and memory shouldn't be a rigid preset template. Beyond the ready-to-use base modes, the plugin lets you adjust how memory runs through custom scenes and types and the options on the settings page. The plugin is still at an early stage and many parts still need work; more combinable modules are planned to make it more freely plastic and help you build the memory that fits you best.

## Getting started

1. **Chat as usual** and the plugin notes what is worth remembering. Each time it saves something, a small card appears under the reply: open it to see what was saved, delete it right there, or jump to the Memory page to edit it further.
2. **Start a new chat** and click the whale-tail icon below the input box to see how many memories this chat brought in and wrote. Open the Memory tab in the right sidebar to see exactly which memories were injected and which were written along the way.
3. **Open the Memory entry at the top left** to browse global memories and every project's memories in one place. You can search, edit and delete them, and recover anything deleted in the last 14 days.
4. **Try a checkup**: click Check now or set up Auto checkup. Issues that need you are collected under To do with carefully analysed suggestions, and the final call is yours.

## More

Guides, configuration and more are on the [GitHub project page](https://github.com/KKL08/dsh-plastic-memory); the guides are in Chinese for now.

> **If the plugin helps you, a ⭐ on [GitHub](https://github.com/KKL08/dsh-plastic-memory) is much appreciated.**
