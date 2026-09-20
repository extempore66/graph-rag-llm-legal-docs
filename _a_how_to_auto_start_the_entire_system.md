Before you start
- Find the binary path with which ollama. It's /usr/local/bin/ollama on Intel and /opt/homebrew/bin/ollama on Apple silicon. Use that in the first plist. launchd has almost no PATH, so absolute paths are required.
- Don't run Ollama.app at the same time. If the app is a login item, it grabs port 11434 and ollama serve fails. Pick one, and remove the app from Login Items if you go with this.

File 1: ~/Library/LaunchAgents/com.budubasa.ollama-serve.plist (the server, kept alive)
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.budubasa.ollama-serve</string>

  <key>ProgramArguments</key>
  <array>
    <string>/PATH/TO/ollama</string>
    <string>serve</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <!-- -1 = never unload a model from memory once loaded -->
    <key>OLLAMA_KEEP_ALIVE</key>
    <string>-1</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/budubasa/Library/Logs/ollama-serve.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/budubasa/Library/Logs/ollama-serve.log</string>
</dict>
</plist>

File 2: ~/Library/LaunchAgents/com.budubasa.ollama-warmup.plist (loads the models once, then exits)
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.budubasa.ollama-warmup</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>until /usr/bin/curl -sf -o /dev/null http://127.0.0.1:11434/api/tags; do sleep 2; done; /usr/bin/curl -s -o /dev/null http://127.0.0.1:11434/api/generate -d '{"model":"qwen3:8b","keep_alive":-1}'; /usr/bin/curl -s -o /dev/null http://127.0.0.1:11434/api/embed -d '{"model":"bge-large:latest","input":"warmup","keep_alive":-1}'</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/budubasa/Library/Logs/ollama-warmup.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/budubasa/Library/Logs/ollama-warmup.log</string>
</dict>
</plist>
Replace /PATH/TO/ollama, CHAT_MODEL_NAME, and EMBED_MODEL_NAME. The script first waits until the server answers, then loads the chat model and the embedding model. If you have two chat models, copy the /api/generate call once per model.

How the two files work
- Serve uses KeepAlive, so launchd restarts Ollama if it crashes. OLLAMA_KEEP_ALIVE=-1 stops Ollama unloading models after the default 5 minutes idle.
- Warmup has no KeepAlive, so it runs once at login and exits. That's what you want, since the models then stay loaded.



File 3: ~/Library/LaunchAgents/com.budubasa.graphrag-node.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.budubasa.graphrag-node</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>--env-file=.env</string>
    <string>src/server.js</string>
  </array>

  <!-- --env-file=.env and src/server.js are relative, so this must be the node/ folder -->
  <key>WorkingDirectory</key>
  <string>/Users/budubasa/Documents/N_Claude_Projects/arango_graph_rag_llm/node</string>

  <key>RunAtLoad</key>
  <true/>
  <!-- Restart on crash, but wait 10s between attempts so a startup failure doesn't spin -->
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>/Users/budubasa/Library/Logs/graphrag-node.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/budubasa/Library/Logs/graphrag-node.log</string>
</dict>
</plist>

Things to know before you load it

- Load it after the Ollama agents. launchd gives no ordering guarantee between agents, so at login the server may start before Ollama is answering. KeepAlive will restart the server if it crashes on that. A fetch failed from a request made before Ollama was up is also possible, so give it a few seconds after login.
- Your project is in ~/Documents, which macOS protects. The first time node reads files there from a background job, you may get a permission prompt ("node would like to access files in your Documents folder"). If you miss it or deny it, the server fails silently with permission errors in the log. Allow it, or fix it later under System Settings → Privacy & Security → Files and Folders.
- Only one instance can hold port 8100. If you also run npm start by hand while the agent is running, the second one fails with EADDRINUSE. Stop the agent first with launchctl bootout gui/$(id -u)/com.budubasa.graphrag-node.
- A code change needs a restart. Run launchctl kickstart -k gui/$(id -u)/com.budubasa.graphrag-node to restart it in place.
- The log is at ~/Library/Logs/graphrag-node.log. That's where the fetch failed cause line would show up, so tail -f it while testing.




When you're ready, run these yourself:
plutil -lint ~/Library/LaunchAgents/com.budubasa.ollama-serve.plist ~/Library/LaunchAgents/com.budubasa.ollama-warmup.plist ~/Library/LaunchAgents/com.budubasa.graphrag-node.plist

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.budubasa.ollama-serve.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.budubasa.ollama-warmup.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.budubasa.graphrag-node.plist

ollama ps            # both models should show up

plutil -lint catches XML typos before you load anything. To remove one later: launchctl bootout gui/$(id -u)/com.budubasa.ollama-serve. Logs are in ~/Library/Logs/.

Limits, per the agent-vs-daemon point from earlier
- These start at login, not boot. After a reboot, someone has to log in, or you enable auto-login, which is only advisable if you accept the FileVault and physical-security trade-off. I can walk through the LaunchDaemon route for true boot-time start when you want it.


// Now for docker:

Docker already has a mechanism for restarting containers, so a LaunchAgent for Arango would duplicate it.
1. Set the container's restart policy (one-time, on the existing container):
docker update --restart unless-stopped arangodb-instance
   Find the name with docker ps -a. Docker then brings the container back whenever the Docker engine starts, and after crashes.
2. Make Docker Desktop itself start at login: Docker Desktop → Settings → General → "Start Docker Desktop when you sign in".




