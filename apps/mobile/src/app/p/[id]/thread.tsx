import { useLocalSearchParams } from "expo-router";
import { ConversationScreen } from "../../../features/chat/ConversationScreen";

export default function ThreadScreen() {
  const { id, cid, title } = useLocalSearchParams<{
    id: string;
    cid: string;
    title?: string;
  }>();
  if (!id || !cid) return null;
  return (
    <ConversationScreen
      projectId={id}
      conversationId={cid}
      title={title ?? "Thread"}
      inThread
    />
  );
}
