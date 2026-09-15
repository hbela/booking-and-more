"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { DashboardShell, useDashboardContext, useSignInRedirect } from "./dashboard-shell";
import { Button, ButtonLink } from "./ui/button";
import { Card } from "./ui/card";
import { ErrorText } from "./ui/field";
import { Input } from "./ui/input";
import { conversationListQuery } from "@/lib/conversation-list-query";

interface Settings {
  enabled: boolean;
  personaName: string;
  businessDescription: string | null;
  supportedLocales: string[];
  escalationMessage: string | null;
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
  const t = useTranslations("assistant");
  const locale = useLocale();
  const context = useDashboardContext();
  useSignInRedirect(!context.isPending && !context.me);
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [offset, setOffset] = useState(0);
  const entitled = context.me?.features.assistant === true;
  const enabled = Boolean(context.tenantId && context.can("conversation:read:all") && entitled);
  const settings = useQuery({
    queryKey: ["assistant-settings", context.tenantId],
    queryFn: () => apiFetch<Settings>("/v1/assistant/settings", { tenantId: context.tenantId }),
    enabled,
  });
  const conversations = useQuery({
    queryKey: ["assistant-conversations", context.tenantId, date, offset],
    queryFn: () =>
      apiFetch<{ items: Conversation[] }>(
        `/v1/assistant/conversations?${conversationListQuery(date, offset)}`,
        {
          tenantId: context.tenantId,
        },
      ),
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
    mutationFn: (body: Partial<Settings>) =>
      apiFetch<Settings>("/v1/assistant/settings", {
        method: "PATCH",
        tenantId: context.tenantId,
        body,
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["assistant-settings"] }),
  });
  if (context.isPending || !context.me) return <p className="p-8">{t("loading")}</p>;
  if (!context.can("conversation:read:all"))
    return (
      <DashboardShell context={context}>
        <p>{t("noAccess")}</p>
      </DashboardShell>
    );
  if (!entitled)
    return (
      <DashboardShell context={context}>
        <Card title={t("title")} description={t("planRequired")}>
          <ButtonLink href="/dashboard/subscription">{t("viewSubscription")}</ButtonLink>
        </Card>
      </DashboardShell>
    );
  return (
    <DashboardShell context={context}>
      <div className="grid gap-6">
        {stats.error || conversations.error || detail.error ? (
          <ErrorText>{t("error")}</ErrorText>
        ) : null}
        <Card title={t("usage")}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Metric label={t("conversations")} value={stats.data?.total ?? 0} />
            <Metric label={t("active")} value={stats.data?.active ?? 0} />
            <Metric label={t("successful")} value={stats.data?.successful ?? 0} />
            <Metric label={t("inputTokens")} value={stats.data?.inputTokens ?? 0} />
            <Metric label={t("outputTokens")} value={stats.data?.outputTokens ?? 0} />
          </div>
        </Card>
        <Card title={t("settings")} description={t("settingsHint")}>
          {settings.error || save.isError ? <ErrorText>{t("error")}</ErrorText> : null}
          {save.isSuccess ? <p role="status">{t("saved")}</p> : null}
          {settings.data ? (
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                save.mutate({
                  enabled: data.get("enabled") === "on",
                  personaName: textField(data, "personaName"),
                  supportedLocales: ["hu", "en", "de", "fr"],
                });
              }}
            >
              <label className="flex items-center gap-2">
                <input name="enabled" type="checkbox" defaultChecked={settings.data.enabled} />{" "}
                {t("enabled")}
              </label>
              <label>
                {t("personaName")}
                <Input
                  name="personaName"
                  defaultValue={settings.data.personaName}
                  required
                  maxLength={80}
                  aria-describedby="persona-name-hint"
                />
              </label>
              <p id="persona-name-hint" className="text-sm text-ink-muted">
                {t("personaNameHint")}
              </p>
              <Button type="submit" disabled={save.isPending || !context.can("assistant:manage")}>
                {t("save")}
              </Button>
            </form>
          ) : (
            <p>{t("loading")}</p>
          )}
        </Card>
        <Card title={t("conversations")}>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm">
              {t("activityDate")}
              <Input
                type="date"
                value={date}
                onChange={(event) => {
                  setDate(event.target.value);
                  setOffset(0);
                  setSelected(null);
                }}
              />
            </label>
            <Button
              variant="secondary"
              disabled={!date}
              onClick={() => {
                setDate("");
                setOffset(0);
                setSelected(null);
              }}
            >
              {t("allDates")}
            </Button>
          </div>
          <p className="mb-3 text-xs text-ink-muted">{t("dateHint")}</p>
          {conversations.isPending ? (
            <p>{t("loading")}</p>
          ) : conversations.data?.items.length === 0 ? (
            <p>{t("noConversations")}</p>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            <ul
              className="grid max-h-[32rem] content-start gap-2 overflow-y-auto"
              aria-label={t("conversations")}
            >
              {conversations.data?.items.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    aria-pressed={selected === row.id}
                    className="w-full rounded-lg border border-line p-3 text-left hover:bg-surface-raised aria-pressed:border-primary aria-pressed:bg-primary-surface"
                    onClick={() => setSelected(row.id)}
                  >
                    <strong>{t(`status.${row.status}`)}</strong> ·{" "}
                    {new Intl.DisplayNames([locale], { type: "language" }).of(row.locale)}
                    <span className="block text-xs text-ink-muted">
                      {new Date(row.lastActivityAt).toLocaleString(locale)} ·{" "}
                      {t("turns", { count: row.turnCount })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div>
              {detail.isFetching ? <p role="status">{t("loading")}</p> : null}
              {!selected ? (
                <p className="text-sm text-ink-muted">{t("selectConversation")}</p>
              ) : null}
              <ol
                className="grid max-h-[32rem] content-start gap-2 overflow-y-auto"
                aria-label={t("transcript")}
              >
                {detail.data?.messages.map((message) => (
                  <li key={message.id} className="rounded-lg bg-surface-raised p-3 text-sm">
                    <strong>{t(`sender.${message.sender}`)}</strong>
                    <p>{message.content}</p>
                  </li>
                ))}
              </ol>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button
              variant="secondary"
              disabled={offset === 0 || conversations.isFetching}
              onClick={() => {
                setOffset(offset - 25);
                setSelected(null);
              }}
            >
              {t("previous")}
            </Button>
            <span className="text-sm">{t("page", { number: offset / 25 + 1 })}</span>
            <Button
              variant="secondary"
              disabled={conversations.isFetching || (conversations.data?.items.length ?? 0) < 25}
              onClick={() => {
                setOffset(offset + 25);
                setSelected(null);
              }}
            >
              {t("next")}
            </Button>
          </div>
        </Card>
      </div>
    </DashboardShell>
  );
}
function textField(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === "string" ? value.trim() : "";
}
function Metric({ label, value }: { label: string; value: number }): React.ReactElement {
  const locale = useLocale();
  return (
    <div className="rounded-lg bg-surface-raised p-3">
      <span className="block text-xs text-ink-muted">{label}</span>
      <strong>{value.toLocaleString(locale)}</strong>
    </div>
  );
}
