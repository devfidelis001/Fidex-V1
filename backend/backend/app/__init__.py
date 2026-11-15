"""FIDEX AI Python backend.

Steps 4-5 scope: a communication layer plus local SQLite storage. The backend answers structured
requests from the Electron main process over stdin/stdout and keeps conversations, messages and
tasks in a local database. It contains NO AI reasoning, no Ollama/Qwen and no browser automation.
"""

__version__ = "0.8.0"
PROTOCOL_VERSION = 1
