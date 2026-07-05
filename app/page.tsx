export default function Home() {
  return (
    <main>
      <h1>🚇 MTA Transit MCP</h1>
      <p>
        This is a remote MCP server exposing realtime <strong>NYC subway</strong> and{" "}
        <strong>LIRR</strong> data (arrivals, departures, and service alerts) as tools for
        Claude.
      </p>
      <h2>Add it to Claude</h2>
      <ol>
        <li>
          In claude.ai, go to <strong>Settings → Connectors</strong>
        </li>
        <li>
          Click <strong>Add custom connector</strong>
        </li>
        <li>
          Paste this URL: <code>{"<this-domain>"}/mcp</code>
        </li>
        <li>
          In a chat, click <strong>+</strong> → <strong>Connectors</strong> and toggle it on
        </li>
      </ol>
      <p>
        Then ask things like <em>&ldquo;When&rsquo;s the next train from Penn to Port
        Washington?&rdquo;</em>, <em>&ldquo;What time is the last train home Saturday
        night?&rdquo;</em>, <em>&ldquo;I need to be at Penn by 9am Thursday — which train
        should I take?&rdquo;</em>, or <em>&ldquo;Any planned work on the N/W this
        weekend?&rdquo;</em>
      </p>
      <p style={{ color: "#666", fontSize: "0.9em" }}>
        Data: MTA GTFS-Realtime feeds. Not affiliated with the MTA. Times are best-effort
        realtime estimates.
      </p>
    </main>
  );
}
