"""Workflow store + run contracts (``tui_gateway/methods_workflow.py``).

The stored documents and the run-event payloads are owned by the Workflows plugin
(``apps/desktop/src/plugins/workflows``) and the runner (``workflow/runner.py``);
the event vocabulary is the engine's (see the plugin's ``protocol.ts``). The
gateway only carries them, so those shapes stay open here.
"""

from __future__ import annotations

from pydantic import Field

from .base import JsonValue, Params, Payload, Result
from .common import OpenModel
from .registry import event, method


class WorkflowDocsPutParams(Params):
    docs: list[JsonValue]
    currentId: str | None = None


class WorkflowIdParams(Params):
    id: str = Field(min_length=1)


class WorkflowStartParams(Params):
    workflowId: str = ""
    scenario: JsonValue | None = None
    payload: JsonValue | None = None
    source: str = "manual"


class RunIdParams(Params):
    runId: str = Field(min_length=1)


class WorkflowRunEventsParams(RunIdParams):
    after: int = -1


class WorkflowRunRespondParams(RunIdParams):
    nodeId: str = Field(min_length=1)
    decision: str
    by: str | None = None


class WorkflowRunEventParams(Params):
    name: str = ""
    payload: JsonValue | None = None


class DocumentsResult(OpenModel):
    """One ``workflow.store.*`` reply: the docs (plugin-owned shape) plus webhook triggers."""

    docs: list[JsonValue] = Field(default_factory=list)
    currentId: str | None = None
    webhooks: dict[str, JsonValue] | None = None
    triggers: JsonValue | None = None


class RunStateResult(OpenModel):
    """One run row (``workflow/runs/<id>.json``); the runner owns the fields beyond runId/status."""

    runId: str
    status: str


class WorkflowStartedResult(Result):
    runId: str
    status: str | None = None


class WorkflowRunEventsResult(Result):
    run: JsonValue | None = None
    events: list[JsonValue] = Field(default_factory=list)
    runId: str | None = None


class WorkflowRunActiveResult(Result):
    run: JsonValue | None = None
    events: list[JsonValue] = Field(default_factory=list)
    runId: str | None = None


class WorkflowRunEventResult(Result):
    started: list[str] = Field(default_factory=list)


method("workflow.store.list", params=Params, result=DocumentsResult,
       doc="Every workflow document under HERMES_HOME/workflows, plus webhook triggers.")
method("workflow.store.put", params=WorkflowDocsPutParams, result=DocumentsResult,
       doc="Save the workflow documents and return the synced webhook triggers.")
method("workflow.store.remove", params=WorkflowIdParams, result=DocumentsResult,
       doc="Delete one workflow document and return the remainder.")
method("workflow.run.start", params=WorkflowStartParams, result=WorkflowStartedResult,
       doc="Start a gateway run of a stored workflow graph.")
method("workflow.run.events", params=WorkflowRunEventsParams, result=WorkflowRunEventsResult,
       doc="One run's state and the events after a sequence number (runId 404s when unknown).")
method("workflow.run.active", params=WorkflowIdParams, result=WorkflowRunActiveResult,
       doc="The workflow's newest run and its events (null run when none).")
method("workflow.run.respond", params=WorkflowRunRespondParams, result=RunStateResult,
       doc="Answer a run's parked human-approval step (approved / denied).")
method("workflow.run.event", params=WorkflowRunEventParams, result=WorkflowRunEventResult,
       doc="Emit a named event that parked wait/gate steps may be waiting for.")
method("workflow.run.pause", params=RunIdParams, result=RunStateResult,
       doc="Request a pause: the loop stops at the next step boundary.")
method("workflow.run.resume", params=RunIdParams, result=RunStateResult,
       doc="Resume a paused run from where it parked.")
method("workflow.run.cancel", params=RunIdParams, result=RunStateResult,
       doc="Cancel a run; in-flight work finishes, nothing new starts.")


class WorkflowRunEventPayload(Payload):
    """One run-event log line (``workflow/store.py::append_event``); ``payload`` is the
    engine's (see the plugin's ``protocol.ts`` — NodeStarted, RunFinished, …)."""

    runId: str
    seq: int
    ts: int
    type: str
    payload: dict[str, JsonValue] = Field(default_factory=dict)


event("workflow.run", WorkflowRunEventPayload,
      doc="A workflow run's event log, folded live by the Workflows canvas.")
