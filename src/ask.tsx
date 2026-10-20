import { Action, ActionPanel, Icon, List, type LaunchProps } from "@raycast/api";
import { useEffect, useState } from "react";
import { AnswerView } from "./components/AnswerView";
import { ModelActions } from "./components/ModelActions";
import { useModelSettings } from "./hooks/useModelSettings";
import { choiceSummary } from "./lib/format";

export default function AskQuestion(props: LaunchProps<{ arguments: Arguments.Ask }>) {
  // When used as a fallback command, the root search text arrives as `fallbackText`.
  const initialQuestion = (props.arguments?.question || props.fallbackText || "").trim();
  const [question, setQuestion] = useState(initialQuestion);
  const [round, setRound] = useState(0);

  if (!question) {
    return (
      <QuestionInput
        onSubmit={(next) => {
          setQuestion(next);
          setRound((current) => current + 1);
        }}
      />
    );
  }
  return <AnswerView key={round} question={question} onAskAnother={() => setQuestion("")} />;
}

function QuestionInput({ onSubmit }: { onSubmit: (question: string) => void }) {
  const modelSettings = useModelSettings();
  const [text, setText] = useState("");
  const question = text.trim();

  useEffect(() => {
    modelSettings.provider.warmUp();
  }, []);

  return (
    <List
      navigationTitle={choiceSummary(modelSettings.choice, modelSettings.provider.name)}
      searchBarPlaceholder="Ask a question…"
      searchText={text}
      onSearchTextChange={setText}
      filtering={false}
    >
      <List.EmptyView
        icon={{ source: "empty-icon.png" }}
        title={question ? "Press ↵ to Ask" : "Ask a Quick Question"}
        description={
          "One answer, no chat to manage. Continue in a chat if you have a follow-up.\n" +
          "Tip: add Ask Question as a fallback command to ask straight from the root search."
        }
        actions={
          <ActionPanel>
            {question ? <Action title="Ask" icon={Icon.ArrowRight} onAction={() => onSubmit(question)} /> : null}
            <ModelActions modelSettings={modelSettings} />
          </ActionPanel>
        }
      />
    </List>
  );
}
