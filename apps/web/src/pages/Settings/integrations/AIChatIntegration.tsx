import React, { useState, useEffect } from 'react';

export default function AIChatIntegration() {
  const [chatApiKey, setChatApiKey] = useState('');
  const [chatProvider, setChatProvider] = useState<'anthropic' | 'openai' | 'google'>('anthropic');
  const [chatConfigured, setChatConfigured] = useState(false);
  const [chatSource, setChatSource] = useState<'none' | 'environment' | 'org'>('none');
  const [chatLoading, setChatLoading] = useState(false);
  const [savingChat, setSavingChat] = useState(false);
  const [testingChat, setTestingChat] = useState(false);
  const [chatTestResult, setChatTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [chatMsg, setChatMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchChatConfig = async () => {
    setChatLoading(true);
    try {
      const res = await fetch('/api/settings/chat', { credentials: 'same-origin' });
      const data = await res.json();
      setChatConfigured(data.configured || data.hasKey);
      setChatProvider(data.llmProvider || 'anthropic');
      setChatSource(data.source || 'none');
    } catch { /* ignore */ }
    setChatLoading(false);
  };

  useEffect(() => {
    fetchChatConfig();
  }, []);

  const handleSaveChatConfig = async () => {
    if (!chatApiKey) { setChatMsg({ type: 'error', text: 'API key is required' }); return; }
    setSavingChat(true);
    setChatMsg(null);
    try {
      const res = await fetch('/api/settings/chat', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ apiKey: chatApiKey, llmProvider: chatProvider }),
      });
      const data = await res.json();
      if (res.ok) {
        setChatMsg({ type: 'success', text: 'AI Chat configuration saved' });
        setChatConfigured(true);
        setChatSource('org');
        setChatApiKey('');
      } else {
        setChatMsg({ type: 'error', text: data.error || 'Failed to save' });
      }
    } catch (err: any) {
      setChatMsg({ type: 'error', text: err.message });
    }
    setSavingChat(false);
  };

  const handleTestChat = async () => {
    setTestingChat(true);
    setChatTestResult(null);
    try {
      const res = await fetch('/api/settings/chat/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ apiKey: chatApiKey || undefined, llmProvider: chatProvider }),
      });
      const data = await res.json();
      setChatTestResult(data);
    } catch (err: any) {
      setChatTestResult({ success: false, error: err.message });
    }
    setTestingChat(false);
  };

  return (
    <section className="card space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center text-xl">
            <svg viewBox="0 0 24 24" className="w-6 h-6 fill-gray-200">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold">AI Provider</h2>
            <p className="text-sm text-gray-500">One LLM key powers Chat, AI session titles, and any other LLM-backed feature in Origin.</p>
          </div>
        </div>
        {chatLoading ? (
          <span className="badge-gray text-xs">Loading...</span>
        ) : chatConfigured ? (
          <span className="badge-green text-xs">
            {chatSource === 'org' ? 'Org Key' : chatSource === 'environment' ? 'Server Key' : 'Configured'}
          </span>
        ) : (
          <span className="badge-gray text-xs">Not Configured</span>
        )}
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">Provider</label>
          <select
            value={chatProvider}
            onChange={(e) => {
              setChatProvider(e.target.value as 'anthropic' | 'openai' | 'google');
              setChatApiKey('');
            }}
            className="select w-full"
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="google">Google AI</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            {chatProvider === 'anthropic' ? 'Anthropic' : chatProvider === 'openai' ? 'OpenAI' : 'Google AI'} API Key
          </label>
          <input
            type="password"
            value={chatApiKey}
            onChange={(e) => setChatApiKey(e.target.value)}
            className="input w-full"
            placeholder={chatConfigured ? '••••••••••••••••••' : chatProvider === 'anthropic' ? 'sk-ant-...' : chatProvider === 'openai' ? 'sk-...' : 'AIza...'}
          />
          <p className="text-xs text-gray-500 mt-1">
            {chatSource === 'environment' && 'Server environment key is active. Add an org key to override it.'}
            {chatSource === 'org' && 'Organization key is configured. Enter a new key to update it.'}
            {chatSource === 'none' && 'Required for the in-app AI assistant and AI-powered session reviews.'}
          </p>
        </div>

        {chatMsg && (
          <div className={`text-sm px-3 py-2 rounded-lg ${chatMsg.type === 'success' ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}>
            {chatMsg.text}
          </div>
        )}

        {chatTestResult && (
          <div className={`text-sm px-3 py-2 rounded-lg ${chatTestResult.success ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}>
            {chatTestResult.success ? 'Connection successful' : `Connection failed: ${chatTestResult.error}`}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button onClick={handleSaveChatConfig} disabled={savingChat} className="btn-primary">
            {savingChat ? 'Saving...' : 'Save'}
          </button>
          <button onClick={handleTestChat} disabled={testingChat} className="btn-secondary">
            {testingChat ? 'Testing...' : 'Test Connection'}
          </button>
        </div>
      </div>
    </section>
  );
}
