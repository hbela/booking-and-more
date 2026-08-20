"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { DashboardShell, useDashboardContext, useSignInRedirect } from "./dashboard-shell";
import { Button, ButtonLink } from "./ui/button";
import { Card } from "./ui/card";
import { Input, Textarea } from "./ui/input";

interface Settings {
  enabled: boolean;
  personaName: string;
  businessDescription: string | null;
  supportedLocales: string[];
  escalationMessage: string | null;
}
interface Faq {
  id: string;
  locale: "en" | "hu";
  question: string;
  answer: string;
  active: boolean;
  sortOrder: number;
}
interface Conversation {
  id: string;
  locale: string;
  status: string;
  turnCount: number;
  outcomeSuccessful: boolean | null;
  lastActivityAt: string;
}
interface Stats {
  total: number;
  active: number;
  completed: number;
  successful: number;
  inputTokens: number;
  outputTokens: number;
}

export function AssistantScreen(): React.ReactElement {
  const context = useDashboardContext();
  useSignInRedirect(!context.isPending && !context.me);
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const entitled = context.me?.features.assistant === true;
  const enabled = Boolean(context.tenantId && context.can("conversation:read:all") && entitled);
  const settings = useQuery({
    queryKey: ["assistant-settings", context.tenantId],
    queryFn: () => apiFetch<Settings>("/v1/assistant/settings", { tenantId: context.tenantId }),
    enabled,
  });
  const faqs = useQuery({
    queryKey: ["assistant-faqs", context.tenantId],
    queryFn: () => apiFetch<{ items: Faq[] }>("/v1/assistant/faqs", { tenantId: context.tenantId }),
    enabled,
  });
  const conversations = useQuery({
    queryKey: ["assistant-conversations", context.tenantId],
    queryFn: () =>
      apiFetch<{ items: Conversation[] }>("/v1/assistant/conversations?limit=50&offset=0", {
        tenantId: context.tenantId,
      }),
    enabled,
  });
  const stats = useQuery({
    queryKey: ["assistant-stats", context.tenantId],
    queryFn: () =>
      apiFetch<Stats>("/v1/assistant/conversations/stats", { tenantId: context.tenantId }),
    enabled,
  });
  const detail = useQuery({
    queryKey: ["assistant-conversation", context.tenantId, selected],
    queryFn: () =>
      apiFetch<{ messages: Array<{ id: string; sender: string; content: string }> }>(
        `/v1/assistant/conversations/${selected}`,
        { tenantId: context.tenantId },
      ),
    enabled: enabled && Boolean(selected),
  });
  const save = useMutation({
    mutationFn: (body: Settings) =>
      apiFetch<Settings>("/v1/assistant/settings", {
        method: "PATCH",
        tenantId: context.tenantId,
        body,
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["assistant-settings"] }),
  });
  const addFaq = useMutation({
    mutationFn: (body: Omit<Faq, "id">) =>
      apiFetch<Faq>("/v1/assistant/faqs", { method: "POST", tenantId: context.tenantId, body }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["assistant-faqs"] }),
  });
  const removeFaq = useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/v1/assistant/faqs/${id}`, { method: "DELETE", tenantId: context.tenantId }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["assistant-faqs"] }),
  });
  if (context.isPending || !context.me) return <p className="p-8">Loading…</p>;
  if (!context.can("conversation:read:all"))
    return (
      <DashboardShell context={context}>
        <p>You do not have access to assistant conversations.</p>
      </DashboardShell>
    );
  if (!entitled)
    return (
      <DashboardShell context={context}>
        <Card
          title="AI Receptionist"
          description="AI chat, the website widget, transcripts, and the monthly token allowance are included with the AI Receptionist plan."
        >
          <ButtonLink href="/dashboard/subscription">View subscription</ButtonLink>
        </Card>
      </DashboardShell>
    );
  return (
    <DashboardShell context={context}>
      <div className="grid gap-6">
        <Card title="Assistant usage">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Metric label="Conversations" value={stats.data?.total ?? 0} />
            <Metric label="Active" value={stats.data?.active ?? 0} />
            <Metric label="Successful" value={stats.data?.successful ?? 0} />
            <Metric label="Input tokens" value={stats.data?.inputTokens ?? 0} />
            <Metric label="Output tokens" value={stats.data?.outputTokens ?? 0} />
          </div>
        </Card>
        <Card
          title="Settings"
          description="Enablement also requires an active plan, provider configuration, and remaining quota."
        >
          {settings.data ? (
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                save.mutate({
                  enabled: data.get("enabled") === "on",
                  personaName: textField(data, "personaName"),
                  businessDescription: nullable(data.get("description")),
                  supportedLocales: data
                    .getAll("locales")
                    .filter((value): value is string => typeof value === "string"),
                  escalationMessage: nullable(data.get("escalation")),
                });
              }}
            >
              <label className="flex items-center gap-2">
                <input name="enabled" type="checkbox" defaultChecked={settings.data.enabled} />{" "}
                Enabled
              </label>
              <label>
                Persona name
                <Input
                  name="personaName"
                  defaultValue={settings.data.personaName}
                  required
                  maxLength={80}
                />
              </label>
              <label>
                Business description
                <Textarea
                  name="description"
                  defaultValue={settings.data.businessDescription ?? ""}
                  maxLength={4000}
                />
              </label>
              <fieldset>
                <legend>Languages</legend>
                <label className="mr-4">
                  <input
                    name="locales"
                    type="checkbox"
                    value="en"
                    defaultChecked={settings.data.supportedLocales.includes("en")}
                  />{" "}
                  English
                </label>
                <label>
                  <input
                    name="locales"
                    type="checkbox"
                    value="hu"
                    defaultChecked={settings.data.supportedLocales.includes("hu")}
                  />{" "}
                  Hungarian
                </label>
              </fieldset>
              <label>
                Escalation message
                <Textarea
                  name="escalation"
                  defaultValue={settings.data.escalationMessage ?? ""}
                  maxLength={1000}
                />
              </label>
              <Button type="submit" disabled={save.isPending}>
                Save settings
              </Button>
            </form>
          ) : (
            <p>Loading…</p>
          )}
        </Card>
        <Card title="FAQs">
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              addFaq.mutate(
                {
                  locale: data.get("locale") === "hu" ? "hu" : "en",
                  question: textField(data, "question"),
                  answer: textField(data, "answer"),
                  active: true,
                  sortOrder: 0,
                },
                { onSuccess: () => form.reset() },
              );
            }}
          >
            <select
              name="locale"
              className="min-h-11 rounded-lg border border-line-strong bg-surface px-3"
            >
              <option value="en">English</option>
              <option value="hu">Hungarian</option>
            </select>
            <Input name="question" placeholder="Question" required maxLength={500} />
            <Textarea name="answer" placeholder="Answer" required maxLength={4000} />
            <Button type="submit">Add FAQ</Button>
          </form>
          <ul className="grid gap-2">
            {faqs.data?.items.map((faq) => (
              <li
                key={faq.id}
                className="flex items-start justify-between rounded-lg border border-line p-3"
              >
                <div>
                  <strong>
                    [{faq.locale}] {faq.question}
                  </strong>
                  <p className="text-sm text-ink-muted">{faq.answer}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => removeFaq.mutate(faq.id)}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Conversations">
          <div className="grid gap-4 md:grid-cols-2">
            <ul className="grid content-start gap-2">
              {conversations.data?.items.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className="w-full rounded-lg border border-line p-3 text-left hover:bg-surface-raised"
                    onClick={() => setSelected(row.id)}
                  >
                    <strong>{row.status}</strong> · {row.locale}
                    <span className="block text-xs text-ink-muted">
                      {new Date(row.lastActivityAt).toLocaleString()} · {row.turnCount} turns
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <ol className="grid content-start gap-2">
              {detail.data?.messages.map((message) => (
                <li key={message.id} className="rounded-lg bg-surface-raised p-3 text-sm">
                  <strong>{message.sender}</strong>
                  <p>{message.content}</p>
                </li>
              ))}
            </ol>
          </div>
        </Card>
      </div>
    </DashboardShell>
  );
}
function nullable(value: FormDataEntryValue | null): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}
function textField(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === "string" ? value.trim() : "";
}
function Metric({ label, value }: { label: string; value: number }): React.ReactElement {
  return (
    <div className="rounded-lg bg-surface-raised p-3">
      <span className="block text-xs text-ink-muted">{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}
