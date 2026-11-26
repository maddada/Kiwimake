// "Delete my account" (docs/CLOUD.md section 6): what goes and what stays, the two things to take
// first (the data file, the signing keys), then a confirm in two taps. The cloud ends the plan at
// Stripe, deletes every cloud app with its chat, files and builds, and every row about the person;
// signing keys stay locked for the grace period, then go. The phone signs out at once.
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft } from "lucide-react-native";
import { api, cloudMessage } from "@/lib/cloud";
import { Button, IconButton } from "@/ui/Button";
import { DownloadDataCard, PrivacyCard } from "@/ui/Privacy";
import { T } from "@/ui/Text";
import { size, space, useTheme } from "@/ui/theme";

type Summary = {
  apps: { id: string; name: string; place: "cloud" | "pc"; hasKey: boolean; repo: string | null }[];
  plan: { name: string; cancelAtPeriodEnd: boolean } | null;
  /** Keys of deleted apps, kept for the grace period: they can still be saved. */
  keptKeys?: { name: string; packageName: string; until: number }[];
  keyGraceDays: number;
  github: string | null;
};

/** The words the cloud expects with the confirmation (privacy.DELETE_WORDS). */
const DELETE_WORDS = "delete my account";

function Bullet({ children }: { children: string }) {
  return (
    <View style={{ flexDirection: "row", gap: space.sm }}>
      <T color="textSecondary">•</T>
      <T style={{ flex: 1 }}>{children}</T>
    </View>
  );
}

export default function DeleteAccountScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const summary = useQuery(api.privacy.summary, {}) as Summary | undefined;
  const remove = useMutation(api.privacy.deleteAccount);
  const { signOut } = useAuthActions();
  const [stage, setStage] = useState<"ask" | "sure" | "deleting" | "done">("ask");
  const [error, setError] = useState<string | null>(null);
  const back = () => (router.canGoBack() ? router.back() : router.replace("/"));

  const go = async () => {
    setStage("deleting");
    setError(null);
    try {
      await remove({ confirm: DELETE_WORDS });
      await signOut().catch(() => undefined);
      setStage("done");
    } catch (e) {
      setError(cloudMessage(e));
      setStage("sure");
    }
  };

  if (stage === "done") {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top + space["2xl"], paddingHorizontal: size.screenGutter, gap: space.lg }} testID="delete-account-done">
        <T variant="display">Your account is deleted</T>
        <T variant="lede" color="textSecondary">
          Your plan is cancelled and your cloud apps and their data are being removed now; it takes a minute. Apps on this phone and on your PC stay as they are.
        </T>
        <View style={{ alignItems: "flex-end" }}>
          <Button label="Done" onPress={() => router.replace("/")} testID="delete-account-close" />
        </View>
      </View>
    );
  }

  const cloudApps = summary?.apps.filter((a) => a.place === "cloud") ?? [];
  const withKeys = [...(summary?.apps.filter((a) => a.hasKey) ?? []), ...(summary?.keptKeys ?? [])];
  const graceDays = summary?.keyGraceDays ?? 30;
  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <View style={{ flexDirection: "row", paddingHorizontal: size.screenGutter, paddingTop: space.sm }}>
        <IconButton icon={ArrowLeft} label="Back" onPress={back} />
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: size.screenGutter, paddingBottom: insets.bottom + space["2xl"], gap: space.lg }}>
        <T variant="display">Delete your account</T>
        <T variant="lede" color="textSecondary">
          This deletes your Kiwimake account and everything the cloud keeps for it.
        </T>
        <PrivacyCard testID="delete-account-what">
          <T variant="row">What happens</T>
          {summary?.plan ? (
            <Bullet>
              {summary.plan.cancelAtPeriodEnd
                ? `Your ${summary.plan.name} plan, already set to end, stops now. Nothing more is charged.`
                : `Your ${summary.plan.name} plan is cancelled now. Nothing more is charged.`}
            </Bullet>
          ) : null}
          <Bullet>
            {cloudApps.length
              ? `Your ${cloudApps.length === 1 ? "cloud app is" : `${cloudApps.length} cloud apps are`} deleted: chats, pictures, pages, builds and saved settings.`
              : "Your chats, pictures, pages, builds and saved settings in the cloud are deleted."}
          </Bullet>
          {summary?.github ? <Bullet>{`Their code stays on your GitHub (${summary.github}), because it is yours. You can remove Kiwimake Cloud in GitHub's settings, under Applications.`}</Bullet> : null}
          <Bullet>{`Apps on your phone stay installed. To update them later, save their signing keys first: we keep the keys locked for ${graceDays} days in case you change your mind, then delete them.`}</Bullet>
          <Bullet>Your PC keeps making apps; it needs no account.</Bullet>
        </PrivacyCard>

        <T variant="eyebrow" color="textTertiary">
          Before you go
        </T>
        <DownloadDataCard />
        {withKeys.length ? (
          <PrivacyCard testID="delete-account-keys">
            <T variant="row">Save signing keys</T>
            <T variant="caption" color="textSecondary">
              {`${withKeys.length === 1 ? `${withKeys[0].name}'s key` : `The keys of your ${withKeys.length} apps`}, in one file locked with a password you pick.`}
            </T>
            <View style={{ alignItems: "flex-end" }}>
              <Button small variant="quiet" label="Save signing keys" onPress={() => router.push("/keys")} testID="delete-account-keys-go" />
            </View>
          </PrivacyCard>
        ) : null}

        <PrivacyCard testID="delete-account-confirm">
          <T variant="row">{stage === "ask" ? "Delete my account" : "Delete your account for good?"}</T>
          <T variant="caption" color={stage === "ask" ? "textSecondary" : "text"}>
            {stage === "ask" ? "You can't undo this." : "This can't be undone. Your cloud apps and their data go now."}
          </T>
          {error ? (
            <T variant="caption" color="problem">
              {error}
            </T>
          ) : null}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
            {stage === "ask" ? (
              <Button small variant="problem" label="Delete my account" disabled={!summary} onPress={() => setStage("sure")} testID="delete-account-go" />
            ) : (
              <>
                <Button small variant="quiet" label="Cancel" onPress={() => setStage("ask")} testID="delete-account-cancel" />
                <Button small variant="problem" label="Delete for good" busy={stage === "deleting"} onPress={() => void go()} testID="delete-account-sure" />
              </>
            )}
          </View>
        </PrivacyCard>
      </ScrollView>
    </View>
  );
}
