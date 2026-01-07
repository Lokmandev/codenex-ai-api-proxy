# CODENEX-AI-PROXY-API

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/docker-supported-blue.svg)](https://www.docker.com/)

**Unified AI Gateway for Multiple LLM Providers**

A powerful, production-ready API proxy that provides a single unified interface to multiple AI model providers. Route requests to OpenAI, Anthropic Claude, Google Gemini, and Claude Code through one API with automatic protocol translation, provider pooling, and intelligent failover.

---

## Features

- **Multi-Provider Support** - 6 providers: Gemini CLI OAuth, Gemini Antigravity, OpenAI, OpenAI Responses API, Claude, Claude Code
- **Protocol Bridging** - Automatic translation between OpenAI, Claude, and Gemini API formats
- **Streaming Support** - Full SSE streaming for all providers
- **Tool Calling / Function Calling** - Cross-provider tool calling with automatic format conversion
- **Vision / Image Support** - Image inputs supported across all providers
- **Structured Output** - JSON schema and structured output support
- **Provider Pooling** - Multiple provider instances with health tracking and automatic failover
- **OAuth Authentication** - Built-in OAuth 2.0 flow for Google Gemini providers
- **Web Management UI** - Configure providers, view usage, and manage credentials
- **Master-Worker Architecture** - Graceful restarts and process isolation

---

## Supported Providers

| Provider | Type | Models | Authentication |
|----------|------|--------|----------------|
| **Gemini CLI OAuth** | `gemini-cli-oauth` | gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.5-pro, gemini-2.5-pro-preview-06-05, gemini-2.5-flash-preview-09-2025, gemini-3-pro-preview, gemini-3-flash-preview | OAuth 2.0 |
| **Gemini Antigravity** | `gemini-antigravity` | gemini-2.5-computer-use-preview-10-2025, gemini-3-pro-image-preview, gemini-3-pro-preview, gemini-3-flash-preview, gemini-2.5-flash, gemini-claude-sonnet-4-5, gemini-claude-sonnet-4-5-thinking, gemini-claude-opus-4-5-thinking | OAuth 2.0 |
| **OpenAI Custom** | `openai-custom` | Any OpenAI-compatible models (gpt-4o, gpt-4-turbo, gpt-3.5-turbo, etc.) | API Key |
| **OpenAI Responses** | `openaiResponses-custom` | OpenAI Responses API models | API Key |
| **Claude Custom** | `claude-custom` | All Anthropic Claude models (claude-3-opus, claude-3-sonnet, claude-3-haiku, etc.) | API Key |
| **Claude Code** | `claudeCode-custom` | opus, sonnet, haiku | Local Claude Code CLI |

---

## API Compatibility

The proxy exposes **three API formats** that can route to any backend provider:

### Exposed Endpoints

| API Format | Endpoint | Method | Description |
|------------|----------|--------|-------------|
| **OpenAI Chat** | `/v1/chat/completions` | POST | Standard OpenAI chat completions |
| **OpenAI Models** | `/v1/models` | GET | List available models |
| **OpenAI Responses** | `/v1/responses` | POST | OpenAI Responses API format |
| **Claude Messages** | `/v1/messages` | POST | Anthropic Claude messages format |
| **Gemini Generate** | `/v1beta/models/{model}:generateContent` | POST | Google Gemini content generation |
| **Gemini Stream** | `/v1beta/models/{model}:streamGenerateContent` | POST | Google Gemini streaming |
| **Gemini Models** | `/v1beta/models` | GET | List Gemini models |

### Cross-Provider Routing

You can use **any client format** with **any backend provider**:

```
OpenAI Client  ──┐
                 ├──> CODENEX-AI-PROXY-API ──> Gemini Backend
Claude Client  ──┤                 ──> OpenAI Backend
                 │                 ──> Claude Backend
Gemini Client  ──┘                 ──> Claude Code
```

---

## Feature Support Matrix

| Feature | OpenAI | Claude | Gemini | Antigravity | OpenAI Responses | Claude Code |
|---------|:------:|:------:|:------:|:-----------:|:----------------:|:-----------:|
| Tool Calling | Yes | Yes | Yes | Yes | Yes | Yes |
| Structured Output | Yes | Yes | Partial | Yes | Yes | Yes |
| Streaming | Yes | Yes | Yes | Yes | Yes | Yes |
| Vision/Images | Yes | Yes | Yes | Yes | Yes | Yes |
| OAuth Support | No | No | Yes | Yes | No | No |
| Custom Base URL | Yes | Yes | No | No | Yes | No |
| Provider Pooling | Yes | Yes | Yes | Yes | Yes | Yes |

---

## Installation

### Prerequisites

- Node.js 20 or higher
- npm or yarn
- (Optional) Docker and Docker Compose
- (Optional) Claude Code CLI for `claudeCode-custom` provider

### Quick Start

```bash
# Clone the repository
git clone <repository-url>
cd ai-proxy-api

# Install dependencies
npm install

# Create configuration directory
mkdir -p configs

# Start the server
npm start
```

### Docker Deployment

```bash
# Build and run with Docker Compose
docker-compose up -d

# Or build manually
docker build -t ai-proxy-api .
docker run -p 3000:3000 -p 8085:8085 -p 8086:8086 \
  -v ./configs:/app/configs \
  -v ./logs:/app/logs \
  -v ~/.claude:/root/.claude \
  ai-proxy-api
```

### Ports

| Port | Purpose |
|------|---------|
| 3000 | Main API & Web UI |
| 8085 | Gemini CLI OAuth callback |
| 8086 | Antigravity OAuth callback |

---

## Configuration

### Environment Variables

Create a `.env` file or set environment variables:

```bash
# Required: API key for client authentication
REQUIRED_API_KEY=your-secure-api-key

# Optional: Default model provider
MODEL_PROVIDER=gemini-cli-oauth

# OpenAI Configuration (for openai-custom provider)
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1/

# Claude Configuration (for claude-custom provider)
CLAUDE_API_KEY=sk-ant-...
CLAUDE_BASE_URL=https://api.anthropic.com

# Gemini Configuration
GEMINI_BASE_URL=https://cloudcode-pa.googleapis.com

# Logging
PROMPT_LOG_MODE=console  # console, file, or none
PROMPT_LOG_FILENAME=logs/conversation.log

# System Proxy (optional)
USE_SYSTEM_PROXY_GEMINI=true
USE_SYSTEM_PROXY_OPENAI=true
USE_SYSTEM_PROXY_CLAUDE=true
```

### Google OAuth Setup (Required for Gemini Providers)

To use `gemini-cli-oauth` or `gemini-antigravity` providers, you need to create Google OAuth credentials.

1.  **Create a Google Cloud Project**
    *   Go to [Google Cloud Console](https://console.cloud.google.com/).
    *   Create a new project.

2.  **Enable APIs**
    *   Go to **APIs & Services > Library**.
    *   Enable **"Google Cloud Platform API"**.

3.  **Configure Consent Screen**
    *   Go to **APIs & Services > OAuth consent screen**.
    *   Select **External** (for personal/testing) or **Internal**.
    *   Fill in required details (App name, email).
    *   Add scope: `https://www.googleapis.com/auth/cloud-platform`.
    *   Add your email as a **Test User**.

4.  **Create Credentials**
    *   Go to **APIs & Services > Credentials**.
    *   Click **+ CREATE CREDENTIALS** > **OAuth client ID**.
    *   Type: **Web application**.
    *   Name: "Gemini Proxy".
    *   **Authorized redirect URIs** (Add both):
        *   `http://localhost:8085` (For Gemini CLI provider)
        *   `http://localhost:8086` (For Antigravity provider)

5.  **Configure Environment**
    *   Copy the **Client ID** and **Client Secret**.
    *   Add them to your `.env` file (see [Environment Variables](#environment-variables)).

### Provider Configuration

Providers can be configured via the Web UI at `http://localhost:3000` or by editing configuration files in the `configs/` directory.

---

## Usage Guide

This section provides comprehensive examples for integrating with CODENEX-AI-PROXY-API using various formats and SDKs.

### Table of Contents

- [Quick Start](#quick-start-examples)
- [cURL Examples](#curl-examples)
- [Python SDK](#python-sdk-examples)
- [Node.js/JavaScript SDK](#nodejs-javascript-sdk-examples)
- [Response Formats](#response-formats)
- [Error Handling](#error-handling)
- [Best Practices](#best-practices)

---

### Quick Start Examples

#### Verify Connection

```bash
# Health check
curl http://localhost:3000/health

# List available models
curl -H "Authorization: Bearer YOUR_API_KEY" http://localhost:3000/v1/models
```

---

### cURL Examples

#### Basic Chat Completion (OpenAI Format)

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "max_tokens": 1000,
    "temperature": 0.7
  }'
```

#### Streaming Response

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -N \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Tell me a story about a robot"}],
    "stream": true,
    "max_tokens": 500
  }'
```

#### Multi-turn Conversation

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      {"role": "system", "content": "You are a math tutor."},
      {"role": "user", "content": "What is 25 * 4?"},
      {"role": "assistant", "content": "25 * 4 = 100"},
      {"role": "user", "content": "Now divide that by 5"}
    ]
  }'
```

#### Tool Calling / Function Calling

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "What is the weather in Tokyo and New York?"}],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get the current weather in a location",
          "parameters": {
            "type": "object",
            "properties": {
              "location": {"type": "string", "description": "City name"},
              "unit": {"type": "string", "enum": ["celsius", "fahrenheit"], "default": "celsius"}
            },
            "required": ["location"]
          }
        }
      }
    ],
    "tool_choice": "auto"
  }'
```

#### Submitting Tool Results

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      {"role": "user", "content": "What is the weather in Tokyo?"},
      {"role": "assistant", "content": null, "tool_calls": [
        {"id": "call_123", "type": "function", "function": {"name": "get_weather", "arguments": "{\"location\": \"Tokyo\"}"}}
      ]},
      {"role": "tool", "tool_call_id": "call_123", "content": "{\"temperature\": 22, \"condition\": \"sunny\"}"}
    ]
  }'
```

#### Vision / Image Analysis

```bash
# Using base64-encoded image
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "What objects do you see in this image? Describe them in detail."},
          {
            "type": "image_url",
            "image_url": {
              "url": "data:image/jpeg;base64,/9j/4AAQSkZJRg..."
            }
          }
        ]
      }
    ],
    "max_tokens": 1000
  }'

# Using image URL
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "Describe this image"},
          {"type": "image_url", "image_url": {"url": "https://example.com/image.jpg"}}
        ]
      }
    ]
  }'
```

#### Structured Output (JSON Schema)

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Extract: John Smith is 30 years old, works as a software engineer at Google, and lives in San Francisco."}],
    "response_format": {
      "type": "json_schema",
      "json_schema": {
        "name": "person_info",
        "strict": true,
        "schema": {
          "type": "object",
          "properties": {
            "name": {"type": "string", "description": "Full name"},
            "age": {"type": "integer", "description": "Age in years"},
            "occupation": {"type": "string", "description": "Job title"},
            "company": {"type": "string", "description": "Employer name"},
            "city": {"type": "string", "description": "City of residence"}
          },
          "required": ["name", "age", "occupation", "company", "city"],
          "additionalProperties": false
        }
      }
    }
  }'
```

#### Claude API Format

```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "gemini-2.5-flash",
    "max_tokens": 1024,
    "system": "You are a helpful coding assistant. Always provide clean, well-commented code.",
    "messages": [
      {"role": "user", "content": "Write a Python function to calculate fibonacci numbers"}
    ]
  }'
```

#### Gemini API Format

```bash
curl -X POST "http://localhost:3000/v1beta/models/gemini-2.5-flash:generateContent?key=YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "role": "user",
        "parts": [{"text": "Explain quantum computing in simple terms"}]
      }
    ],
    "generationConfig": {
      "maxOutputTokens": 1000,
      "temperature": 0.7,
      "topP": 0.9
    },
    "safetySettings": [
      {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_MEDIUM_AND_ABOVE"}
    ]
  }'
```

#### Gemini Streaming

```bash
curl -X POST "http://localhost:3000/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=YOUR_API_KEY&alt=sse" \
  -H "Content-Type: application/json" \
  -N \
  -d '{
    "contents": [{"role": "user", "parts": [{"text": "Write a poem about the ocean"}]}]
  }'
```

#### Provider-Specific Routing

```bash
# Route via path prefix
curl -X POST http://localhost:3000/openai-custom/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}'

# Route via header
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Model-Provider: claude-custom" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-3-sonnet-20240229", "messages": [{"role": "user", "content": "Hello"}]}'
```

#### Claude Code Models (Auto-Routing)

```bash
# Models opus, sonnet, haiku auto-route to claudeCode-custom
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "messages": [{"role": "user", "content": "Write a Python class for a binary search tree"}]
  }'
```

---

### Python SDK Examples

#### Installation

```bash
pip install openai anthropic
```

#### OpenAI SDK (Recommended)

```python
from openai import OpenAI

# Initialize client pointing to CODENEX-AI-PROXY-API
client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="http://localhost:3000/v1"
)

# Basic chat completion
response = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "What is the capital of France?"}
    ],
    max_tokens=500,
    temperature=0.7
)

print(response.choices[0].message.content)
```

#### Streaming with OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="http://localhost:3000/v1"
)

# Streaming response
stream = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Tell me a long story"}],
    stream=True,
    max_tokens=1000
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()  # Newline at end
```

#### Tool Calling with OpenAI SDK

```python
from openai import OpenAI
import json

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="http://localhost:3000/v1"
)

# Define tools
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get current weather for a location",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {"type": "string", "description": "City name"},
                    "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
                },
                "required": ["location"]
            }
        }
    }
]

# Initial request
response = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "What's the weather in London?"}],
    tools=tools,
    tool_choice="auto"
)

message = response.choices[0].message

# Check if model wants to call a tool
if message.tool_calls:
    for tool_call in message.tool_calls:
        function_name = tool_call.function.name
        arguments = json.loads(tool_call.function.arguments)
        
        # Execute the function (your implementation)
        if function_name == "get_weather":
            result = {"temperature": 18, "condition": "cloudy", "humidity": 75}
        
        # Send result back
        response = client.chat.completions.create(
            model="gemini-2.5-flash",
            messages=[
                {"role": "user", "content": "What's the weather in London?"},
                message,
                {"role": "tool", "tool_call_id": tool_call.id, "content": json.dumps(result)}
            ]
        )
        print(response.choices[0].message.content)
```

#### Vision with OpenAI SDK

```python
from openai import OpenAI
import base64

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="http://localhost:3000/v1"
)

# Read and encode image
with open("image.jpg", "rb") as f:
    image_base64 = base64.b64encode(f.read()).decode("utf-8")

response = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Describe this image in detail"},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"}
                }
            ]
        }
    ],
    max_tokens=1000
)

print(response.choices[0].message.content)
```

#### Structured Output with OpenAI SDK

```python
from openai import OpenAI
from pydantic import BaseModel

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="http://localhost:3000/v1"
)

# Define schema using Pydantic
class Person(BaseModel):
    name: str
    age: int
    occupation: str
    skills: list[str]

response = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[
        {"role": "user", "content": "Extract info: Alice Johnson, 28, Data Scientist skilled in Python, ML, and SQL"}
    ],
    response_format={
        "type": "json_schema",
        "json_schema": {
            "name": "person",
            "schema": Person.model_json_schema()
        }
    }
)

# Parse response
import json
person_data = json.loads(response.choices[0].message.content)
print(person_data)
```

#### Anthropic SDK

```python
from anthropic import Anthropic

# Initialize client pointing to CODENEX-AI-PROXY-API
client = Anthropic(
    api_key="YOUR_API_KEY",
    base_url="http://localhost:3000"
)

# Create message
response = client.messages.create(
    model="gemini-2.5-flash",  # Will be routed through proxy
    max_tokens=1024,
    system="You are a helpful coding assistant.",
    messages=[
        {"role": "user", "content": "Write a Python function to reverse a string"}
    ]
)

print(response.content[0].text)
```

#### Async Python Example

```python
import asyncio
from openai import AsyncOpenAI

async def main():
    client = AsyncOpenAI(
        api_key="YOUR_API_KEY",
        base_url="http://localhost:3000/v1"
    )
    
    # Concurrent requests
    tasks = [
        client.chat.completions.create(
            model="gemini-2.5-flash",
            messages=[{"role": "user", "content": f"What is {i} + {i}?"}]
        )
        for i in range(5)
    ]
    
    responses = await asyncio.gather(*tasks)
    
    for i, response in enumerate(responses):
        print(f"Response {i}: {response.choices[0].message.content}")

asyncio.run(main())
```

---

### Node.js / JavaScript SDK Examples

#### Installation

```bash
npm install openai @anthropic-ai/sdk
```

#### OpenAI SDK (Node.js)

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
    apiKey: 'YOUR_API_KEY',
    baseURL: 'http://localhost:3000/v1'
});

async function chat() {
    const response = await client.chat.completions.create({
        model: 'gemini-2.5-flash',
        messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Explain JavaScript closures' }
        ],
        max_tokens: 500
    });

    console.log(response.choices[0].message.content);
}

chat();
```

#### Streaming with Node.js

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
    apiKey: 'YOUR_API_KEY',
    baseURL: 'http://localhost:3000/v1'
});

async function streamChat() {
    const stream = await client.chat.completions.create({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Write a haiku about programming' }],
        stream: true
    });

    for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
            process.stdout.write(content);
        }
    }
    console.log();
}

streamChat();
```

#### Tool Calling with Node.js

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
    apiKey: 'YOUR_API_KEY',
    baseURL: 'http://localhost:3000/v1'
});

const tools = [
    {
        type: 'function',
        function: {
            name: 'calculate',
            description: 'Perform mathematical calculations',
            parameters: {
                type: 'object',
                properties: {
                    expression: { type: 'string', description: 'Math expression to evaluate' }
                },
                required: ['expression']
            }
        }
    }
];

async function chatWithTools() {
    const response = await client.chat.completions.create({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'What is 15% of 250?' }],
        tools: tools,
        tool_choice: 'auto'
    });

    const message = response.choices[0].message;
    
    if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
            const args = JSON.parse(toolCall.function.arguments);
            console.log(`Tool called: ${toolCall.function.name}`);
            console.log(`Arguments: ${JSON.stringify(args)}`);
            
            // Execute function and continue conversation...
        }
    } else {
        console.log(message.content);
    }
}

chatWithTools();
```

#### Browser/Fetch Example

```javascript
async function chatCompletion(message) {
    const response = await fetch('http://localhost:3000/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer YOUR_API_KEY',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gemini-2.5-flash',
            messages: [{ role: 'user', content: message }],
            max_tokens: 500
        })
    });

    const data = await response.json();
    return data.choices[0].message.content;
}

// Usage
chatCompletion('Hello, how are you?').then(console.log);
```

#### Streaming in Browser

```javascript
async function streamChat(message, onChunk) {
    const response = await fetch('http://localhost:3000/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer YOUR_API_KEY',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gemini-2.5-flash',
            messages: [{ role: 'user', content: message }],
            stream: true
        })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.startsWith('data: '));
        
        for (const line of lines) {
            const data = line.slice(6);
            if (data === '[DONE]') return;
            
            try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content;
                if (content) onChunk(content);
            } catch (e) {
                // Ignore parse errors
            }
        }
    }
}

// Usage
streamChat('Tell me a joke', (text) => console.log(text));
```

---

### Response Formats

#### OpenAI Chat Completion Response

```json
{
    "id": "chatcmpl-abc123",
    "object": "chat.completion",
    "created": 1704067200,
    "model": "gemini-2.5-flash",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Hello! I'm doing well, thank you for asking."
            },
            "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 25,
        "completion_tokens": 15,
        "total_tokens": 40
    }
}
```

#### Streaming Response (SSE)

```
data: {"id":"chatcmpl-abc123","choices":[{"delta":{"role":"assistant"},"index":0}]}

data: {"id":"chatcmpl-abc123","choices":[{"delta":{"content":"Hello"},"index":0}]}

data: {"id":"chatcmpl-abc123","choices":[{"delta":{"content":"!"},"index":0}]}

data: {"id":"chatcmpl-abc123","choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}

data: [DONE]
```

#### Tool Call Response

```json
{
    "id": "chatcmpl-abc123",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [
                    {
                        "id": "call_xyz789",
                        "type": "function",
                        "function": {
                            "name": "get_weather",
                            "arguments": "{\"location\": \"Tokyo\", \"unit\": \"celsius\"}"
                        }
                    }
                ]
            },
            "finish_reason": "tool_calls"
        }
    ]
}
```

---

### Error Handling

#### Common Error Codes

| HTTP Code | Error Type | Description |
|-----------|------------|-------------|
| 400 | `invalid_request_error` | Malformed request or invalid parameters |
| 401 | `authentication_error` | Invalid or missing API key |
| 403 | `permission_denied` | API key lacks required permissions |
| 404 | `not_found` | Model or endpoint not found |
| 429 | `rate_limit_exceeded` | Too many requests |
| 500 | `internal_error` | Server error |
| 503 | `service_unavailable` | Provider temporarily unavailable |

#### Error Response Format

```json
{
    "error": {
        "message": "Invalid API key provided",
        "type": "authentication_error",
        "code": "invalid_api_key",
        "status": 401
    }
}
```

#### Python Error Handling

```python
from openai import OpenAI, APIError, RateLimitError, AuthenticationError

client = OpenAI(api_key="YOUR_API_KEY", base_url="http://localhost:3000/v1")

try:
    response = client.chat.completions.create(
        model="gemini-2.5-flash",
        messages=[{"role": "user", "content": "Hello"}]
    )
except AuthenticationError:
    print("Invalid API key")
except RateLimitError:
    print("Rate limit exceeded, please retry later")
except APIError as e:
    print(f"API error: {e.message}")
```

#### JavaScript Error Handling

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
    apiKey: 'YOUR_API_KEY',
    baseURL: 'http://localhost:3000/v1'
});

try {
    const response = await client.chat.completions.create({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hello' }]
    });
} catch (error) {
    if (error instanceof OpenAI.AuthenticationError) {
        console.error('Invalid API key');
    } else if (error instanceof OpenAI.RateLimitError) {
        console.error('Rate limit exceeded');
    } else if (error instanceof OpenAI.APIError) {
        console.error(`API error: ${error.message}`);
    }
}
```

---

### Best Practices

#### 1. Use Streaming for Long Responses

Streaming provides better user experience for long-form content:

```python
# Recommended for long responses
stream = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Write a detailed essay..."}],
    stream=True
)
```

#### 2. Set Appropriate Timeouts

```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="http://localhost:3000/v1",
    timeout=60.0  # 60 second timeout
)
```

#### 3. Implement Retry Logic

```python
import time
from openai import OpenAI, RateLimitError

def chat_with_retry(client, messages, max_retries=3):
    for attempt in range(max_retries):
        try:
            return client.chat.completions.create(
                model="gemini-2.5-flash",
                messages=messages
            )
        except RateLimitError:
            if attempt < max_retries - 1:
                wait_time = 2 ** attempt  # Exponential backoff
                time.sleep(wait_time)
            else:
                raise
```

#### 4. Use System Messages Effectively

```python
response = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[
        {
            "role": "system",
            "content": """You are a helpful assistant. Follow these rules:
            1. Be concise and clear
            2. Use examples when helpful
            3. Ask for clarification if needed
            4. Format code with proper syntax highlighting"""
        },
        {"role": "user", "content": "Your question here"}
    ]
)
```

#### 5. Optimize Token Usage

```python
# Be specific about response length
response = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Summarize in 2 sentences: ..."}],
    max_tokens=100  # Limit response tokens
)
```

#### 6. Handle Multiple Providers Gracefully

```python
# Use header to specify provider, with fallback
import requests

def chat_with_fallback(message, providers=["gemini-cli-oauth", "openai-custom"]):
    for provider in providers:
        try:
            response = requests.post(
                "http://localhost:3000/v1/chat/completions",
                headers={
                    "Authorization": "Bearer YOUR_API_KEY",
                    "Model-Provider": provider
                },
                json={"model": "auto", "messages": [{"role": "user", "content": message}]},
                timeout=30
            )
            if response.ok:
                return response.json()
        except Exception:
            continue
    raise Exception("All providers failed")
```

---

## Authentication

### Client Authentication

The proxy supports multiple authentication header formats:

| Format | Example |
|--------|---------|
| Bearer Token (OpenAI) | `Authorization: Bearer YOUR_API_KEY` |
| x-api-key (Claude) | `x-api-key: YOUR_API_KEY` |
| x-goog-api-key (Gemini) | `x-goog-api-key: YOUR_API_KEY` |
| Query Parameter | `?key=YOUR_API_KEY` |

All formats authenticate against the same `REQUIRED_API_KEY` configured on the server.

### OAuth 2.0 for Gemini Providers

Gemini CLI OAuth and Antigravity providers use OAuth 2.0 authentication:

1. **Generate OAuth URL** via Management API or Web UI
2. **Complete browser authentication** with Google
3. **Credentials are stored** in `configs/gemini/oauth_creds.json` or `configs/antigravity/oauth_creds.json`
4. **Automatic token refresh** - tokens are refreshed automatically before expiry

#### OAuth Setup Steps

```bash
# 1. Start the server
npm start

# 2. Open Web UI
open http://localhost:3000

# 3. Navigate to Providers section

# 4. Click "Generate OAuth URL" for Gemini or Antigravity

# 5. Complete authentication in browser

# 6. Provider is automatically configured
```

### Credential File Configuration

OAuth credentials are stored in JSON files:

```
configs/
├── gemini/
│   └── oauth_creds.json       # Gemini CLI OAuth credentials
├── antigravity/
│   └── oauth_creds.json       # Antigravity OAuth credentials
└── provider_pools.json        # Provider pool configuration
```

---

## Provider Routing

### Default Provider

Set the default provider via environment variable:

```bash
MODEL_PROVIDER=gemini-cli-oauth
```

### Path-Based Routing

Route requests to specific providers using path prefixes:

```
/{provider-type}/v1/chat/completions
```

Examples:
- `/gemini-cli-oauth/v1/chat/completions`
- `/openai-custom/v1/chat/completions`
- `/claude-custom/v1/messages`

### Header-Based Routing

Override the provider using the `Model-Provider` header:

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Model-Provider: claude-custom" \
  ...
```

### Auto-Routing for Claude Code

Models `opus`, `sonnet`, and `haiku` are automatically routed to `claudeCode-custom` provider without explicit configuration.

---

## Management API

### Provider Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/providers` | GET | List all configured providers |
| `/api/providers/{type}` | GET | Get providers of specific type |
| `/api/providers/{type}/{uuid}` | PUT | Update provider configuration |
| `/api/providers/{type}/{uuid}/enable` | POST | Enable a provider |
| `/api/providers/{type}/{uuid}/disable` | POST | Disable a provider |
| `/api/providers/{type}/health-check` | POST | Run health check on providers |
| `/api/providers/{type}/reset-health` | POST | Reset health status |

### Configuration

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/config` | GET | Get current configuration |
| `/api/config` | POST | Update configuration |
| `/api/reload-config` | POST | Reload configuration from files |

### Health & Status

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Server health check |
| `/provider_health` | GET | Provider pool health status |
| `/api/system` | GET | System info (memory, CPU, uptime) |
| `/api/service-mode` | GET | Get running mode (worker/standalone) |

### Usage Statistics

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/usage` | GET | Usage statistics for all providers |
| `/api/usage/{type}` | GET | Usage for specific provider type |
| `/api/provider-models` | GET | Get all available models |
| `/api/provider-models/{type}` | GET | Get models for specific provider |

### Configuration Files

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/upload-configs` | GET | List uploaded config files |
| `/api/upload-configs/view/{path}` | GET | View config file content |
| `/api/upload-configs/delete/{path}` | DELETE | Delete config file |
| `/api/upload-configs/download-all` | GET | Download all configs as ZIP |

### Authentication

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/login` | POST | Login to management console |
| `/api/providers/{type}/generate-auth-url` | POST | Generate OAuth URL |
| `/api/upload-oauth-credentials` | POST | Upload OAuth credentials |
| `/api/admin-password` | POST | Update admin password |

### Real-time Events

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/events` | GET | SSE stream for real-time updates |

---

## Web UI

Access the web management interface at `http://localhost:3000`

### Features

- **Dashboard** - Overview of provider status and health
- **Provider Management** - Add, configure, enable/disable providers
- **OAuth Flow** - Initiate OAuth authentication for Gemini providers
- **Configuration Editor** - Edit server configuration
- **Usage Statistics** - View request counts and provider usage
- **Real-time Events** - Live updates via Server-Sent Events

---

## Architecture

### Master-Worker Process Model

```
Master Process (master.js)
    │
    ├── Spawns Worker Process
    │       └── API Server (api-server.js)
    │
    ├── Health Monitoring
    │
    └── Graceful Restart on Crash
```

The master process manages the worker lifecycle, enabling graceful restarts without downtime.

### Request Flow

```
Client Request
    │
    ▼
┌─────────────────────────────────┐
│   Request Handler               │
│   - Authentication              │
│   - Provider Selection          │
│   - Route Matching              │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│   Request Converter             │
│   - Format Translation          │
│   (OpenAI ↔ Claude ↔ Gemini)   │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│   Provider Pool Manager         │
│   - Health-based Selection      │
│   - Fallback Chain              │
│   - Usage Tracking              │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│   Service Adapter               │
│   - API Call Execution          │
│   - Streaming/Unary             │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│   Response Converter            │
│   - Format Translation          │
└─────────────────────────────────┘
    │
    ▼
Client Response
```

### Provider Pool Management

- **Health Tracking** - Error count, last error time, success rate
- **LRU Selection** - Least Recently Used provider selection
- **Automatic Failover** - Switch to healthy providers on failure
- **Configurable Thresholds** - Max error count before marking unhealthy
- **Health Recovery** - Auto-retry unhealthy providers after interval

---

## Scripts

```bash
# Start server (master-worker mode)
npm start

# Start in standalone mode (single process)
npm run start:standalone

# Development mode
npm run start:dev

# Run tests
npm test
npm run test:watch
npm run test:coverage
```

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

```
MIT License

Copyright (c) 2025 CODENEX

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Support

For issues, questions, or suggestions, please open an issue on GitHub.
