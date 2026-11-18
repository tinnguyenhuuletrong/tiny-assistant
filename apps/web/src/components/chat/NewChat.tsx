import type { ThinkingLevel } from "@tiny/core";
import { PanelLeft, Workflow } from "lucide-react";
import { useState } from "react";
import { client } from "../../lib/client.ts";
import { navigate } from "../../lib/router.ts";
import { KEYS, load, save } from "../../lib/storage.ts";
import { useServerState } from "../../lib/store.ts";
import { attempt } from "../../lib/toast.ts";
import { useUi } from "../../lib/ui.ts";
import { IconButton } from "../ui/Button.tsx";
import { parseRunArg } from "./ChatView.tsx";
import { Composer, type SlashCommand } from "./Composer.tsx";
import { ModelPicker, ProjectPicker, ThinkingPicker } from "./Pickers.tsx";

const COMMANDS: SlashCommand[] = [{ name: "run", description: "Run a workflow", argHint: "<workflow>" }];

function greeting(): string {
	const hour = new Date().getHours();
	if (hour < 5) return "Up late?";
	if (hour < 12) return "Good morning";
	if (hour < 18) return "Good afternoon";
	return "Good evening";
}

/** The empty state: pick a project, type, and a session is created on submit. */
export function NewChat({ initialProject }: { initialProject?: string | null }) {
	const ui = useUi();
	const state = useServerState();
	const [chosenProject, setProject] = useState<string | null>(() =>
		initialProject !== undefined ? initialProject : load<string | null>(KEYS.lastProject, null),
	);
	const [model, setModel] = useState<string | null>(null);
	const [thinking, setThinking] = useState<ThinkingLevel | null>(null);
	const [submitting, setSubmitting] = useState(false);

	const projects = state?.projects ?? [];
	const projectId = projects.some((project) => project.id === chosenProject) ? chosenProject : null;
	const models = state?.models ?? [];
	const modelValue = model ?? state?.defaults.model ?? null;
	const currentModel = models.find((item) => `${item.provider}/${item.id}` === modelValue);
	const thinkingValue = thinking ?? state?.defaults.thinking ?? "off";

	const submit = async (text: string) => {
		setSubmitting(true);
		const session = await attempt(() =>
			client.createSession({
				projectId,
				text,
				model: model ?? undefined,
				thinking: thinking ?? undefined,
			}),
		);
		setSubmitting(false);
		if (!session) return false;
		save(KEYS.lastProject, projectId);
		navigate({ name: "session", id: session.id });
		return true;
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="pt-safe shrink-0 md:hidden">
				<div className="flex h-12 items-center px-2">
					<IconButton label="Open sidebar" onClick={ui.showSidebar}>
						<PanelLeft className="size-5" />
					</IconButton>
				</div>
			</header>
			<div className="flex min-h-0 flex-1 flex-col px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] md:justify-center md:px-6">
				<div className="flex flex-1 flex-col items-center justify-center gap-2 text-center md:flex-none md:pb-8">
					<svg viewBox="0 0 512 512" className="size-9" aria-hidden="true">
						<g stroke="var(--accent)" strokeWidth="44" strokeLinecap="round">
							<line x1="256" y1="96" x2="256" y2="416" />
							<line x1="117.4" y1="176" x2="394.6" y2="336" />
							<line x1="117.4" y1="336" x2="394.6" y2="176" />
						</g>
					</svg>
					<h1 className="font-serif text-3xl text-fg tracking-tight md:text-4xl">{greeting()}</h1>
				</div>
				<Composer
					draftKey="new"
					placeholder="How can I help you today?"
					onSubmit={submit}
					submitting={submitting}
					commands={COMMANDS}
					workflows={state?.workflows}
					onCommand={(_, arg) => ui.openWorkflows({ ...parseRunArg(arg), projectId })}
					autoFocus
					toolbar={
						<>
							<ProjectPicker
								value={projectId}
								projects={projects}
								onChange={setProject}
								onAddProject={ui.openAddProject}
							/>
							<ModelPicker value={modelValue} models={models} onChange={setModel} />
							{(!currentModel || currentModel.reasoning) && (
								<ThinkingPicker value={thinkingValue} onChange={setThinking} />
							)}
						</>
					}
				/>
				{(state?.workflows.length ?? 0) > 0 && (
					<div className="mx-auto mt-3 flex w-full max-w-3xl flex-wrap justify-center gap-2">
						<button
							type="button"
							onClick={() => ui.openWorkflows({ projectId })}
							className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-muted text-xs hover:bg-surface-2 hover:text-fg"
						>
							<Workflow className="size-3.5" /> Run a workflow
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
