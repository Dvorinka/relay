# Product vision brief (2026-10-01)

Preserved verbatim from the product owner — the north star for what Relay is
becoming. Analyze against it whenever prioritizing.

> I am going to sleep. You will remain here working autonomously without me
> present as I will be sleeping. Your task is to fully finish this project to
> the fullest extent:
>
> - Everything marked on the roadmap and finished
> - All documentation
> - Making it fully open source and fully community-supported
> - Fully functional
> - The desktop app implemented and fully functional on Windows, which you can
>   test here locally and which I will test myself
> - The web app mainly functional
> - The phone app functional
>
> You should have an Android emulator so you can test it there but be careful
> with the RAM, as it can crash and that wouldn't be good. Keep it limited and
> if it is not suitable for running here, we can test it on a real phone via
> USB debugging later, after I wake up, if that's a better solution for us.
>
> Just finish everything and mark everything on the roadmap. After you finish
> with stuff look at further implementation and further stuff to fill in on
> the roadmap. Keeping it in the loop, continue working on it, reiterating,
> visually analyzing the app, running it locally, testing it, viewing it, and
> really making sure it's fully functional and fully ready for my analysis.
>
> Everything should be in place, functional, without any problems, any
> difficulties with the project, and so on. It should fully be suitable for
> real-world use. Test it against all things in my skill. Make sure everything
> is listed there, tested, verified, and functional. All the documentation is
> clear. There are images in the roadmap. Everything is correct as it should
> be and it functions like it should.
>
> That's your task for now. If you have any questions before that, maybe let's
> see when you finish but I don't think I will be here. I'm going out to sleep
> so do not ask any questions. Figure it out yourself and we can resolve them
> tomorrow if needed.
>
> Really proceed with everything in your capabilities. Perfect the UI. It
> should be really usable, really visually brandable, appealing, and nice for
> the users to use. It should be fully finished, fully functional, and ready
> to be used in a real-world use case.
>
> The main part which we will be examining is the agentic connection to
> GitHub. You can try for yourself using the GH, which is authenticated to my
> Dvorinka account, but do not use the company's account, which also is
> connected to this account. Do not touch it in any way. Just the Dvorinka
> account. That's what you can test everything on, just not the company. Then
> other parts are:
>
> - The text messages themselves
> - Images
> - Agentic access to all the images
> - Able to read it from a CLI
> - Able to read it
>
> Any agent should be able to see them. Test it yourself and maybe spin up a
> SWE2 Max subagent shortly but do not keep it running for long. Otherwise we
> will hit a limit and you will stop working. That's not effective for us.
>
> The Kanban part and issue tracking: these two are basically connected but
> more integrated into the platform. The chat mentions importing the projects
> that we are working on, separate for each chat based on the project. The
> agent should find this out, examine it, and know, based on the MCP, which is
> correct, which truly works, and what project they are currently working on.
> What is related to this date? What was already done?
>
> There should be a to-do for the agent that they can set up again, connected
> to the Kanban:
>
> - What remains based on the users' requests in the texting app.
> - Mark it as done.
> - Mark it as remaining for the work that it must iterate on and work on
>   after.
>
> It should be fully autonomous and the user would just post the issues,
> images, and everything that they find wrong with the platform or not
> functional as it should be. The agent will just take the work and continue
> iterating on it.
>
> It can:
>
> - Pull issues from GitHub.
> - Pull PR requests.
> - Examine PR requests from GitHub, all connected to the app.
> - The user can mention the issues from GitHub directly in their messages.
> - Add some context.
> - Download the images from the issues.
>
> That's another important part we need to look at: just keeping it in the
> loop with every integration we have and making it suitable. Also add a CLI
> because that's even better for some cases than MCP. Integrate a CLI, which
> would also board this and make it easier for the agent to navigate through
> all of the app. This should probably be everything. If there's something
> else I come up with, I will let you know tomorrow. Also do your own
> research, look at concurrencies, look at what other projects could be taken
> as inspiration or directly integrated into the app, and make it truly usable
> for the users and perfect and the perfect solution for this particular
> problem.
>
> The problem we are solving is that when I work I work on multiple devices so
> I take a screenshot from one, then send it over to Discord with some message
> about the issue and so on. Then I take it from Discord on the second machine
> and paste it, again copying it from Discord, downloading the image, and
> pasting it into the agent. This isn't efficient enough and is not the best
> solution that there is.
>
> We are making the best solution that is possible and yet this is what we are
> mainly solving: even making it easier for the user and adding additional
> things and additional stuff. Based on this prompt create and add stuff to
> the roadmap README. Keep this whole prompt in some documentation file
> because it contains valuable information, I think, so you can go back to it,
> analyze what I said here, and just iterate the app.
>
> Our main thing that we need to focus on is the UI. That's the winning point
> in every project so the UI has to be unique, brandable, and really nice for
> the users to use. I think that should cover it.

## Interpreted scope deltas (added to roadmap)

- `relay` CLI (Go, single binary) speaking to the MCP endpoint with `rly_`
  tokens — the agent's low-friction path into Relay.
- Agent-managed project todos, surfaced as a board column — the agent's own
  persistent "what remains" list, linked to issues.
- GitHub references in messages (`owner/repo#123`) linkified; GitHub issues
  and PRs readable via MCP tools.
- Kanban board view for issues.
- Real screenshots in README/ROADMAP.
