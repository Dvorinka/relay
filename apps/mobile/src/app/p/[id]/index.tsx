import { useLocalSearchParams } from "expo-router";
import { ConversationScreen } from "../../../features/chat/ConversationScreen";

export default function ProjectChat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!id) return null;
  return <ConversationScreen projectId={id} />;
}
