// "Download my data" (docs/CLOUD.md section 6, "Deleting an app, an account, and downloading your
// data"): the cloud makes one zip (the account, and per app its code from GitHub, chat, to-dos,
// pages and pictures) and gives a link that works for a short time; the browser downloads it.
import { useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { useAction, useQuery } from "convex/react";
import { api, cloudMessage } from "@/lib/cloud";
import { restoreCloudApp } from "@/lib/manage";
import type { App } from "@/lib/protocol";
import { setState, useStore } from "@/lib/store";
import { Button } from "./Button";
import { T } from "./Text";
import { border, radius, space, useTheme } from "./theme";

export type DownloadLink = { url: string; expiresAt: number; fileName: string; sizeBytes: number };

const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
export const sizeText = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);

/** A card: the words take the full width, the button sits below them on the right (AGENTS.md). */
export function PrivacyCard({ children, testID }: { children: React.ReactNode; testID?: string }) {
  const t = useTheme();
  return <View testID={testID} style={{ borderRadius: radius.card, borderWidth: border.width, borderColor: t.border, backgroundColor: t.surface, padding: space.lg, gap: space.sm }}>{children}</View>;
}

export function DownloadDataCard() {
  const myData = useAction(api.privacyNode.myData);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<DownloadLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const l = (await myData({})) as DownloadLink;
      setLink(l);
      await Linking.openURL(l.url);
    } catch (e) {
      setError(cloudMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <PrivacyCard testID="download-data">
      <T variant="row">Download my data</T>
      <T variant="caption" color="textSecondary">
        One file with your account and, for each cloud app, its code, chat, to-dos, pages and pictures. It takes a moment to make.
      </T>
      {link ? (
        <T variant="caption" testID="download-data-ready">
          {`${link.fileName} (${sizeText(link.sizeBytes)}) is downloading in your browser. The link works until ${clock(link.expiresAt)}.`}
        </T>
      ) : null}
      {error ? <T variant="caption" color="problem">{error}</T> : null}
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
        {link ? <Button small variant="text" label="Open the link again" onPress={() => void Linking.openURL(link.url)} testID="download-data-again" /> : null}
        <Button small variant="quiet" label={busy ? "Making your file" : "Download my data"} busy={busy} onPress={() => void go()} testID="download-data-go" />
      </View>
    </PrivacyCard>
  );
}

/**
 * After a cloud app is deleted on this phone: "<name> is deleted. You can bring it back until 10:42."
 * with Undo, on Home, while the window lasts (Settings, Recently deleted has it too).
 */
export function CloudUndoNotice() {
  const undo = useStore((s) => s.cloudUndo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The notice leaves by itself when the window ends.
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setState((s) => (s.cloudUndo === undo ? { cloudUndo: null } : {})), Math.max(0, undo.until - Date.now()));
    return () => clearTimeout(timer);
  }, [undo]);
  if (!undo) return null;
  return (
    <View style={{ marginBottom: space.md }}>
      <PrivacyCard testID="cloud-undo">
        <T>{`${undo.app.name} is deleted. You can bring it back until ${clock(undo.until)}; then its chat, files and builds are gone for good.`}</T>
        {error ? (
          <T variant="caption" color="problem">
            {error}
          </T>
        ) : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button small variant="text" label="OK" onPress={() => setState({ cloudUndo: null })} testID="cloud-undo-ok" />
          <Button
            small
            variant="quiet"
            label="Undo"
            busy={busy}
            testID="cloud-undo-go"
            onPress={async () => {
              setBusy(true);
              setError(null);
              try {
                await restoreCloudApp(undo.app.id);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          />
        </View>
      </PrivacyCard>
    </View>
  );
}

/** Settings, Recently deleted, for cloud apps: each can come back until its window ends. */
export function CloudRecentlyDeleted({
  Group,
  Row,
}: {
  Group: (p: { title: string; children: React.ReactNode }) => React.ReactElement;
  Row: (p: { app: App; sub: string; children: React.ReactNode }) => React.ReactElement;
}) {
  const list = useQuery(api.apps.recentlyDeleted, {}) as (App & { purgeAt: string })[] | undefined;
  const [busy, setBusy] = useState<string | null>(null);
  if (!list?.length) return null;
  return (
    <Group title="Recently deleted in the cloud">
      <View testID="cloud-recently-deleted" style={{ padding: space.lg }}>
        <T variant="caption" color="textSecondary">
          A cloud app you delete can come back for a few minutes. Then its chat, files and builds are deleted for good; its code stays on your GitHub.
        </T>
      </View>
      {list.map((app) => (
        <Row key={app.id} app={app} sub={`In the cloud. Gone for good at ${clock(new Date(app.purgeAt).getTime())}.`}>
          <Button
            testID={`restore-cloud-${app.slug}`}
            label="Restore"
            variant="quiet"
            small
            busy={busy === app.id}
            onPress={async () => {
              setBusy(app.id);
              await restoreCloudApp(app.id).catch(() => undefined);
              setBusy(null);
            }}
          />
        </Row>
      ))}
    </Group>
  );
}
