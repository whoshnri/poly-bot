import { useState } from 'react'
import axios from 'axios'
import './App.css'

type AgentStatus = 'idle' | 'running' | 'loading'

interface Session {
  sessionId: string
  name: string
  createdAt: string
}

function App() {
  const [status, setStatus] = useState<AgentStatus>('idle')
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleStart() {
    setStatus('loading')
    setError(null)
    try {
      const { data } = await axios.post<Session>('/api/session/start')
      setSession(data)
      setStatus('running')
    } catch (err) {
      setError(
        axios.isAxiosError(err)
          ? (err.response?.data?.error ?? err.message)
          : 'Failed to start agent.'
      )
      setStatus('idle')
    }
  }

  function handleStop() {
    setSession(null)
    setStatus('idle')
    setError(null)
  }

  return (
    <div className="container">
      <header className="header">
        <h1 className="title">Poly Trader Agent</h1>
        <p className="subtitle">Autonomous Polymarket trading agent control panel</p>
      </header>

      <main className="card">
        <div className="status-row">
          <span className={`badge badge--${status}`}>
            {status === 'loading' ? 'Starting…' : status === 'running' ? 'Running' : 'Idle'}
          </span>
        </div>

        {session && (
          <div className="session-info">
            <p><span className="label">Session ID</span><code>{session.sessionId}</code></p>
            <p><span className="label">Name</span>{session.name}</p>
            <p><span className="label">Started</span>{new Date(session.createdAt).toLocaleString()}</p>
          </div>
        )}

        {error && <p className="error">{error}</p>}

        <div className="actions">
          <button
            className="btn btn--start"
            onClick={handleStart}
            disabled={status !== 'idle'}
          >
            Start Agent
          </button>
          <button
            className="btn btn--stop"
            onClick={handleStop}
            disabled={status !== 'running'}
          >
            Stop Agent
          </button>
        </div>
      </main>
    </div>
  )
}

export default App
