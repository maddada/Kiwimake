// "Save signing keys" (docs/CLOUD.md section 6): every cloud app is signed with its own key, and
// Android installs an update only when it carries the same key. The cloud puts the keys of the
// person's apps (or one app's, ?app=<id>&name=<name>) in one file locked with a password they pick,
// in the desktop's key backup format, so Kiwimake on a PC restores them and keeps updating the apps.
import { useState } from "react";
import { Linking, ScrollView, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAction } from "convex/react";
import { ArrowLeft } from "lucide-react-native";
import { api, cloudMessage } from "@/lib/cloud";
import { Button, IconButton } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { PrivacyCard, sizeText, type DownloadLink } from "@/ui/Privacy";
import { T } from "@/ui/Text";
import { size, space, useTheme } from "@/ui/theme";

const MIN_PASSWORD = 8;

export default function KeysScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ app?: string; name?: string }>();
  const save = useAction(api.privacyNode.signingKeys);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<(DownloadLink & { count: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const one = params.app ? (params.name ?? "this app") : null;

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const l = (await save({ password, ...(params.app ? { appIds: [params.app] } : {}) })) as DownloadLink & { count: number };
      setLink(l);
      setPassword("");
      await Linking.openURL(l.url);
    } catch (e) {
      setError(cloudMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <View style={{ flexDirection: "row", paddingHorizontal: size.screenGutter, paddingTop: space.sm }}>
        <IconButton icon={ArrowLeft} label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: size.screenGutter, paddingBottom: insets.bottom + space["2xl"], gap: space.lg }}>
        <T variant="display">{one ? `Save ${one}'s signing key` : "Save signing keys"}</T>
        <T variant="lede" color="textSecondary">
          {one
            ? `${one} is signed with its own key. Android installs an update only when it is signed with the same key, so keep this file if you may want to update ${one} later.`
            : "Each of your apps is signed with its own key. Android installs an update only when it is signed with the same key, so keep this file if you may want to update your apps later."}
        </T>
        <T color="textSecondary">Kiwimake on your PC can open the file: Settings, Signing keys, Restore. Keep it somewhere safe; anyone with the file and its password can sign updates for these apps.</T>
        <PrivacyCard testID="keys-card">
          <T variant="row">A password for the file</T>
          <T variant="caption" color="textSecondary">
            At least {MIN_PASSWORD} characters. You need it to open the file, and we cannot get it back for you.
          </T>
          <Field value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry autoCapitalize="none" autoCorrect={false} testID="keys-password" />
          {error ? (
            <T variant="caption" color="problem">
              {error}
            </T>
          ) : null}
          <View style={{ alignItems: "flex-end" }}>
            <Button small label={one ? "Save the key" : "Save signing keys"} busy={busy} disabled={password.length < MIN_PASSWORD} onPress={() => void go()} testID="keys-save" />
          </View>
        </PrivacyCard>
        {link ? (
          <PrivacyCard testID="keys-ready">
            <T>{`${link.fileName} (${sizeText(link.sizeBytes)}, ${link.count === 1 ? "1 key" : `${link.count} keys`}) is downloading in your browser.`}</T>
            <T variant="caption" color="textSecondary">
              The link works for a short time. If the download did not start, open it again.
            </T>
            <View style={{ alignItems: "flex-end" }}>
              <Button small variant="quiet" label="Open the link again" onPress={() => void Linking.openURL(link.url)} testID="keys-again" />
            </View>
          </PrivacyCard>
        ) : null}
      </ScrollView>
    </View>
  );
}
