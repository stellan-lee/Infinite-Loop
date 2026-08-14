'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import ProviderIcon from '../../icons/ProviderIcon';
import { useProviders } from '@/lib/client/use-providers';

const NODE_TYPE = 'agent';
const PREVIEW_MAX = 40;
const TITLE_ICON_SIZE = 16;

interface AgentData {
  _state?: string;
  label?: string;
  config?: {
    providerId?: string;
    prompt?: string;
    messages?: Array<{ role?: string; content?: string }>;
    cwd?: string;
    timeoutMs?: number;
    agent?: string;
    profile?: string;
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export default function AgentNode({ data, selected }: NodeProps) {
  const d = (data ?? {}) as AgentData;
  const state = d._state ?? 'idle';
  const messages = d.config?.messages;
  const prompt = Array.isArray(messages) && messages.length > 0
    ? messages.filter((message) => message?.role === 'user').at(-1)?.content
      ?? messages.at(-1)?.content
      ?? ''
    : d.config?.prompt ?? '';
  const provider = d.config?.providerId ?? 'claude';
  const agentName = (d.config?.agent ?? '').trim();
  const profileName = (d.config?.profile ?? '').trim();
  const full = prompt || '(no prompt)';
  const preview = truncate(full, PREVIEW_MAX);
  // Surface the full prompt on hover when it's been truncated, so users can
  // peek without opening the config panel.
  const bodyTitle = full !== preview ? full : undefined;
  const customLabel = d.label?.trim();

  // Resolve provider metadata so hermes-local nodes can show their brand
  // icon (registered under "hermes" in ProviderIcon, not under the per-
  // port id like "myhermes-productmanager") and a default title that
  // includes the model name + parent connection.
  const providers = useProviders();
  const info = providers.find((p) => p.id === provider);
  const isHermes = info?.kind === 'hermes-local';
  const isOpenAiProvider = info?.kind === 'openai-local';
  // For hermes-local nodes we override two things:
  //   - the icon lookup key → "hermes" (so the registry mark resolves)
  //   - the auto-title → "<profile> · <connection-label>" if the user
  //     didn't set a custom display name
  const iconKey = isHermes ? 'hermes' : provider;
  const autoTitle = isHermes
    ? info && info.connectionLabel
      ? `${info.label} · ${info.connectionLabel}`
      : info?.label
    : isOpenAiProvider
      ? info?.label
      : undefined;
  const titleText = customLabel || autoTitle;

  return (
    <div
      className="wf-node"
      data-node-type={NODE_TYPE}
      data-state={state}
      data-selected={selected ? 'true' : 'false'}
      aria-label="agent node"
    >
      <Handle type="target" position={Position.Left} id="in" />
      <div className="wf-node-head">
        {/* Brand icon takes the title slot. When a custom display name is
         * set on the node, it sits to the right of the icon; without one,
         * the icon stands alone. We keep .wf-node-title on the wrapper so
         * the per-state / per-node-type color rules still tint icon + text
         * via currentColor (ProviderIcon's mask-image uses currentColor). */}
        <span
          className="wf-node-title wf-node-title-icon"
          aria-label={
            titleText
              ? `${titleText} (${provider} agent)`
              : `${provider} agent`
          }
        >
          <ProviderIcon providerId={iconKey} size={TITLE_ICON_SIZE} />
          {titleText ? (
            <span className="wf-node-title-text">{titleText}</span>
          ) : null}
        </span>
        <span className="wf-node-state-dot" data-state={state} aria-hidden="true" />
      </div>
      {agentName && (
        <div
          className="wf-node-agent"
          aria-label={`subagent ${agentName}`}
          title={`--agent ${agentName}`}
        >
          <span className="wf-node-agent-glyph" aria-hidden="true">
            ⤳
          </span>
          <span className="wf-node-agent-name">{agentName}</span>
        </div>
      )}
      {/* For HTTP providers (Hermes/OpenRouter/...) the user-selected profile
       * is the equivalent of an "agent" — it's the knob that decides which
       * model actually runs. Surfacing it here gives the same at-a-glance
       * card readout as CLI agents. The auto-title already names the
       * profile, but the chip echoes it in the same row position so a
       * mixed CLI/HTTP workflow reads consistently. */}
      {!agentName && profileName && isHermes && (
        <div
          className="wf-node-agent"
          aria-label={`profile ${profileName}`}
          title={`profile: ${profileName}`}
        >
          <span className="wf-node-agent-glyph" aria-hidden="true">
            ⤳
          </span>
          <span className="wf-node-agent-name">{profileName}</span>
        </div>
      )}
      <div className="wf-node-body wf-node-body-italic" title={bodyTitle}>
        {preview}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id="next"
        style={{ top: '40%' }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="error"
        style={{ top: '72%' }}
      />
    </div>
  );
}
