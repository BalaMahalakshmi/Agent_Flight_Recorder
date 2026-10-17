import { useEffect, useState } from "react";

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { detail: text };
    }
  }

  if (!response.ok) {
    const detail = data.detail ?? data.message ?? response.statusText;
    throw new Error(
      typeof detail === "string" ? detail : JSON.stringify(detail, null, 2),
    );
  }

  return data;
}

function formatCost(value) {
  return Number.isFinite(value) ? `$${value.toFixed(6)}` : "—";
}

function formatOutput(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "No output recorded.";
  return JSON.stringify(value, null, 2);
}

function getMessageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part?.text === "string"
          ? part.text
          : JSON.stringify(part, null, 2),
      )
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content, null, 2);
}

function getTaskText(input) {
  const messages = input && Array.isArray(input.messages) ? input.messages : [];
  const firstUserMessage = messages.find((message) => message?.role === "user");
  return firstUserMessage
    ? getMessageText(firstUserMessage.content)
    : "No user message recorded.";
}

function getSystemPrompt(step) {
  return typeof step?.input?.system === "string" ? step.input.system : "";
}

function App() {
  const [runs, setRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [selectedStepIndex, setSelectedStepIndex] = useState(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [loadingRun, setLoadingRun] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [error, setError] = useState("");

  async function openRun(runId) {
    setError("");
    setLoadingRun(true);
    try {
      const run = await requestJson(`/api/runs/${encodeURIComponent(runId)}`);
      setSelectedRun(run);
      const firstStep = run.steps?.[0] ?? null;
      setSelectedStepIndex(firstStep?.index ?? null);
      setSystemPrompt(getSystemPrompt(firstStep));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoadingRun(false);
    }
  }

  useEffect(() => {
    let active = true;

    async function loadRuns() {
      setLoadingRuns(true);
      try {
        const loadedRuns = await requestJson("/api/runs");
        if (!active) return;
        setRuns(loadedRuns);
        if (loadedRuns.length > 0) {
          await openRun(loadedRuns[0].id);
        }
      } catch (requestError) {
        if (active) setError(requestError.message);
      } finally {
        if (active) setLoadingRuns(false);
      }
    }

    loadRuns();
    return () => {
      active = false;
    };
  }, []);

  async function explainFailure() {
    if (!selectedRun) return;
    setError("");
    setExplaining(true);
    try {
      const result = await requestJson(
        `/api/runs/${encodeURIComponent(selectedRun.id)}/explain`,
        { method: "POST" },
      );
      setSelectedRun((current) =>
        current ? { ...current, explanation: result.explanation } : current,
      );
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setExplaining(false);
    }
  }

  async function replayFromStep() {
    if (!selectedRun || !selectedStep || selectedStep.kind !== "llm") return;
    setError("");
    setReplaying(true);
    try {
      const replay = await requestJson(
        `/api/runs/${encodeURIComponent(selectedRun.id)}/replay`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            step_index: selectedStep.index,
            system: systemPrompt,
          }),
        },
      );
      setRuns((currentRuns) => [
        replay,
        ...currentRuns.filter((run) => run.id !== replay.id),
      ]);
      setSelectedRun(replay);
      const firstStep = replay.steps?.[0] ?? null;
      setSelectedStepIndex(firstStep?.index ?? null);
      setSystemPrompt(getSystemPrompt(firstStep));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setReplaying(false);
    }
  }

  const steps = selectedRun?.steps ?? [];
  const selectedStep =
    steps.find((step) => step.index === selectedStepIndex) ?? null;
  const newStepsCost = steps.reduce(
    (total, step) =>
      step.inherited === false
        ? total + (Number.isFinite(step.cost) ? step.cost : 0)
        : total,
    0,
  );

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Recorded runs">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ◉
          </span>
          <div>
            <p className="eyebrow">Agent Flight Recorder</p>
            <h1>Runs</h1>
          </div>
        </div>

        {loadingRuns && runs.length === 0 ? (
          <p className="sidebar-message">Loading runs…</p>
        ) : runs.length === 0 ? (
          <div className="empty-runs">
            <p>No runs yet, run</p>
            <code>python -m demo_agent.run_demo</code>
          </div>
        ) : (
          <nav className="run-list" aria-label="Run list">
            {runs.map((run) => (
              <button
                className={`run-card${selectedRun?.id === run.id ? " active" : ""}`}
                key={run.id}
                onClick={() => openRun(run.id)}
                type="button"
              >
                <span className="run-name">{run.name || "Untitled run"}</span>
                <span className="run-meta">
                  <span className={`status-dot status-${run.status || "unknown"}`} />
                  {run.status || "unknown"}
                  <span className="run-cost">{formatCost(run.total_cost)}</span>
                </span>
                {run.parent_run_id && <span className="replay-tag">replay</span>}
              </button>
            ))}
          </nav>
        )}
      </aside>

      <main className="main-content">
        {error && (
          <div className="error-banner" role="alert">
            <strong>Something went wrong.</strong> {error}
            <button
              aria-label="Dismiss error"
              className="dismiss-error"
              onClick={() => setError("")}
              type="button"
            >
              ×
            </button>
          </div>
        )}

        {loadingRun && !selectedRun ? (
          <div className="welcome-panel">Loading run…</div>
        ) : !selectedRun ? (
          <div className="welcome-panel">
            <span className="welcome-icon" aria-hidden="true">
              ◉
            </span>
            <h2>Your agent’s black box</h2>
            <p>Select a run to inspect its task, result, and step-by-step timeline.</p>
          </div>
        ) : (
          <div className="run-detail">
            {loadingRun && <p className="loading-note">Loading selected run…</p>}
            {selectedRun.parent_run_id && (
              <p className="fork-note">
                Forked from step {selectedRun.forked_from_step},{" "}
                <a
                  href={`#run-${encodeURIComponent(selectedRun.parent_run_id)}`}
                  onClick={(event) => {
                    event.preventDefault();
                    openRun(selectedRun.parent_run_id);
                  }}
                >
                  open original run
                </a>
              </p>
            )}

            <header className="run-header">
              <div>
                <p className="eyebrow">Recorded run</p>
                <h2>{selectedRun.name || "Untitled run"}</h2>
              </div>
              <button
                className="button button-secondary"
                disabled={explaining}
                onClick={explainFailure}
                type="button"
              >
                {explaining ? "Explaining…" : "Explain failure"}
              </button>
            </header>

            <section className="summary-grid" aria-label="Run summary">
              <article className="summary-card">
                <p className="section-label">Task</p>
                <p className="task-text">{getTaskText(selectedRun.input)}</p>
              </article>
              <article className="summary-card answer-card">
                <p className="section-label">Final answer</p>
                <p className="answer-text">{formatOutput(selectedRun.output)}</p>
              </article>
            </section>

            {selectedRun.explanation && (
              <section className="explanation-card" aria-live="polite">
                <p className="section-label">Failure explanation</p>
                <p>{selectedRun.explanation}</p>
              </section>
            )}

            <section className="cost-strip" aria-label="Run costs">
              <div>
                <span className="section-label">Total cost</span>
                <strong>{formatCost(selectedRun.total_cost)}</strong>
              </div>
              <div>
                <span className="section-label">Cost of new steps</span>
                <strong>{formatCost(newStepsCost)}</strong>
              </div>
              <div>
                <span className="section-label">Total tokens</span>
                <strong>{selectedRun.total_tokens ?? "—"}</strong>
              </div>
            </section>

            <section className="trace-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Execution trace</p>
                  <h3>Timeline</h3>
                </div>
                <span className="step-count">{steps.length} steps</span>
              </div>

              {steps.length === 0 ? (
                <p className="no-steps">This run has no recorded steps.</p>
              ) : (
                <div className="timeline-layout">
                  <ol className="timeline">
                    {steps.map((step) => (
                      <li
                        className={`timeline-item ${step.kind === "tool" ? "tool" : "llm"}${
                          step.inherited ? " inherited" : ""
                        }`}
                        key={`${step.index}-${step.name}`}
                      >
                        <button
                          aria-current={
                            selectedStepIndex === step.index ? "step" : undefined
                          }
                          className={`step-button${
                            selectedStepIndex === step.index ? " selected" : ""
                          }`}
                          onClick={() => {
                            setSelectedStepIndex(step.index);
                            setSystemPrompt(getSystemPrompt(step));
                          }}
                          type="button"
                        >
                          <span className="timeline-marker" aria-hidden="true" />
                          <span className="step-title-row">
                            <span className="step-index">
                              {String(step.index).padStart(2, "0")}
                            </span>
                            <span className="step-name">{step.name}</span>
                            {step.inherited && (
                              <span className="inherited-tag">inherited</span>
                            )}
                          </span>
                          <span className="step-meta">
                            <span className="kind-label">
                              {step.kind === "tool" ? "Tool" : "LLM"}
                            </span>
                            <span>
                              {Number.isFinite(step.latency_ms)
                                ? `${step.latency_ms.toFixed(1)} ms`
                                : "—"}
                            </span>
                            <span>{formatCost(step.cost)}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>

                  <div className="step-inspector">
                    {selectedStep ? (
                      <>
                        <div className="inspector-heading">
                          <div>
                            <p className="eyebrow">Step {selectedStep.index}</p>
                            <h4>{selectedStep.name}</h4>
                          </div>
                          <span
                            className={`kind-badge ${
                              selectedStep.kind === "tool" ? "tool-badge" : "llm-badge"
                            }`}
                          >
                            {selectedStep.kind === "tool" ? "Tool" : "LLM"}
                          </span>
                        </div>
                        {selectedStep.error && (
                          <div className="step-error" role="alert">
                            {selectedStep.error}
                          </div>
                        )}
                        <div className="json-panel">
                          <p className="section-label">Input</p>
                          <pre>{formatOutput(selectedStep.input)}</pre>
                        </div>
                        <div className="json-panel">
                          <p className="section-label">Output</p>
                          <pre>{formatOutput(selectedStep.output)}</pre>
                        </div>

                        {selectedStep.kind === "llm" && (
                          <div className="replay-panel">
                            <p className="section-label">Replay from this step</p>
                            <label htmlFor="system-prompt">System prompt</label>
                            <textarea
                              id="system-prompt"
                              onChange={(event) => setSystemPrompt(event.target.value)}
                              rows={5}
                              value={systemPrompt}
                            />
                            <button
                              className="button button-primary"
                              disabled={replaying}
                              onClick={replayFromStep}
                              type="button"
                            >
                              {replaying ? "Replaying…" : "Replay from this step"}
                            </button>
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="no-steps">Select a step to inspect its data.</p>
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
