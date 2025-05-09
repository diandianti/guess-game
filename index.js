import OpenAI from 'openai';

import welcomeHtmlString from './welcome.html';
import sys_prompt from './prompt2.txt';
import faviconSvgString from './favicon.svg';
import { topics } from './topics';
import { getRandomElement } from './utils';

// --- Global Constants and In-Memory Store ---
const chatHistories = new Map(); // chat_id -> Array of {role, content}
const MAX_CHAT_HISTORIES = 100; // Maximum number of chat histories to store

// Max conversation turns (user + assistant) stored in memory per chat_id (doesn't include system prompt)
const MAX_CONVERSATION_MESSAGES_STORED = 40;

// Max messages (system + conversation turns) sent to AI for context
const MAX_MESSAGES_FOR_AI_CONTEXT = 20;

// Initial assistant message for new chats
const INITIAL_BOT_MESSAGE = { role: 'assistant', content: "医生你好" };

// Max character length for user input (server-side validation)
const MAX_INPUT_LENGTH_SERVER = 140;

// Max total messages (user + assistant turns) in a conversation before game over
const MAX_TOTAL_MESSAGES_ALLOWED = 20;

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname === '/api/chat' && request.method === 'POST') {
            return handleChatRequest(request, env);
        }

        if (url.pathname === '/' && request.method === 'GET') {
            return new Response(welcomeHtmlString, {
                headers: { 'Content-Type': 'text/html;charset=UTF-8' },
            });
        }

        if (url.pathname === '/favicon.svg') {
            return new Response(faviconSvgString, {
                headers: { 'Content-Type': 'image/svg+xml' },
            });
        }

        return new Response('Not Found', { status: 404 });
    },
};

function get_sys_prompt() {
    return {
        role: "system",
        content: sys_prompt.replaceAll("<%= topic %>", getRandomElement(topics)),
    };
}

async function handleChatRequest(request, env) {
    try {
        const requestBody = await request.json();
        let { message: userMessageContent, chat_id: chatId } = requestBody;

        // --- Input Validation ---
        if (!userMessageContent) {
            return new Response(JSON.stringify({ detail: '消息内容不能为空' }), {
                status: 400, headers: { 'Content-Type': 'application/json;charset=UTF-8' }
            });
        }
        if (userMessageContent.length > MAX_INPUT_LENGTH_SERVER) {
            return new Response(JSON.stringify({ detail: `输入内容超过 ${MAX_INPUT_LENGTH_SERVER} 个字符限制` }), {
                status: 400, headers: { 'Content-Type': 'application/json;charset=UTF-8' }
            });
        }
        // --- End Input Validation ---

        const BYPASS_AI_ENABLED = env.BYPASS_AI_MODE === "true";

        if (!chatId) {
            chatId = crypto.randomUUID();
        }

        // Maintain max chatHistories size
        if (chatHistories.size >= MAX_CHAT_HISTORIES) {
            const oldestChatId = chatHistories.keys().next().value;
            chatHistories.delete(oldestChatId);
            console.log(`Deleted oldest chat history for chat_id ${oldestChatId} to maintain max size of ${MAX_CHAT_HISTORIES}.`);
        }

        // currentUserHistory stores only assistant and user messages
        let currentUserHistory = chatHistories.get(chatId);
        if (!currentUserHistory) {
            currentUserHistory = { topic: get_sys_prompt(), history: [INITIAL_BOT_MESSAGE] };
        }
        currentUserHistory.history.push({ role: 'user', content: userMessageContent });

        // --- Check for Max Total Messages Limit ---
        if (currentUserHistory.history.length > MAX_TOTAL_MESSAGES_ALLOWED) {
            chatHistories.delete(chatId);
            console.log(`Chat history for chat_id ${chatId} deleted: exceeded MAX_TOTAL_MESSAGES_ALLOWED (${MAX_TOTAL_MESSAGES_ALLOWED}).`);
            const limitReachedPayload = {
                reply: "尝试次数过多，游戏结束，请重新开始。",
                chat_id: chatId,
                right: false,
                gameOver: true,
                gameOverReason: "limit_reached"
            };
            return new Response(JSON.stringify(limitReachedPayload), {
                headers: { 'Content-Type': 'application/json;charset=UTF-8' },
            });
        }
        // --- End Max Total Messages Limit Check ---

        let rawAiReplyContent;
        let isCorrectGuess = false;

        if (BYPASS_AI_ENABLED) {
            rawAiReplyContent = JSON.stringify({ text_reply: "旁路模式：这是测试回复。", right: false });
            console.log(`Bypass mode for chat_id: ${chatId}. Returning: "${rawAiReplyContent}"`);
        } else {
            if (!env.OPENAI_API_KEY) {
                console.error("FATAL: OPENAI_API_KEY environment variable not set.");
                return new Response(JSON.stringify({ detail: 'AI服务未配置或配置错误，请联系管理员。' }), {
                    status: 503, headers: { 'Content-Type': 'application/json;charset=UTF-8' }
                });
            }

            const openai = new OpenAI({
                apiKey: env.OPENAI_API_KEY,
                baseURL: env.OPENAI_API_BASE_URL || undefined,
            });

            // Prepare messages for OpenAI
            let conversationTurnsForAI = [...currentUserHistory.history];
            if (conversationTurnsForAI.length > (MAX_MESSAGES_FOR_AI_CONTEXT - 1)) {
                conversationTurnsForAI = conversationTurnsForAI.slice(conversationTurnsForAI.length - (MAX_MESSAGES_FOR_AI_CONTEXT - 1));
            }
            const messagesForOpenAI = [currentUserHistory.topic, ...conversationTurnsForAI];

            try {
                console.log("Sending messages to AI:", messagesForOpenAI);
                const completion = await openai.chat.completions.create({
                    model: env.OPENAI_MODEL || "gpt-4o",
                    messages: messagesForOpenAI,
                });

                console.log("AI response:", completion.choices[0].message);
                if (completion.choices && completion.choices.length > 0 && completion.choices[0].message) {
                    rawAiReplyContent = completion.choices[0].message.content?.trim();
                    // Remove ```json ``` if present
                    if (rawAiReplyContent.startsWith('```json') && rawAiReplyContent.endsWith('```')) {
                        rawAiReplyContent = rawAiReplyContent.slice(7, -3).trim();
                    }
                } else {
                    rawAiReplyContent = JSON.stringify({ text_reply: "AI返回了意外的或空的响应结构。", right: false });
                }
            } catch (e) {
                console.error("OpenAI API call error:", e);
                rawAiReplyContent = JSON.stringify({ text_reply: `调用AI服务时出错: ${e.message || '未知错误'}`, right: false });
            }
        }

        let finalUserVisibleReply = rawAiReplyContent;
        try {
            const parsedContent = JSON.parse(rawAiReplyContent);
            if (parsedContent && typeof parsedContent.text_reply === 'string' && typeof parsedContent.right === 'boolean') {
                finalUserVisibleReply = parsedContent.text_reply;
                isCorrectGuess = parsedContent.right;
            } else {
                console.warn("AI response was not in the expected JSON format. Raw content:", rawAiReplyContent);
                if (typeof rawAiReplyContent !== 'string') {
                    finalUserVisibleReply = "AI的回复格式不正确或无法解析。";
                }
            }
        } catch (e) {
            console.warn("Failed to parse AI's raw reply as JSON. Raw content:", rawAiReplyContent);
            if (typeof rawAiReplyContent !== 'string') {
                finalUserVisibleReply = "AI的回复无法被解析。";
            }
        }

        // Add AI's response to the conversation history
        currentUserHistory.history.push({ role: 'assistant', content: finalUserVisibleReply });

        let gameOver = false;
        let gameOverReason = null;

        if (isCorrectGuess) {
            chatHistories.delete(chatId);
            console.log(`Chat history for chat_id ${chatId} deleted (reason: correct_guess).`);
            gameOver = true;
            gameOverReason = "correct_guess";
        } else {
            // Truncate history if necessary
            if (currentUserHistory.history.length > MAX_CONVERSATION_MESSAGES_STORED) {
                if (currentUserHistory.history.length > 0 && currentUserHistory.history[0].content === INITIAL_BOT_MESSAGE.content && currentUserHistory[0].role === INITIAL_BOT_MESSAGE.role) {
                    const conversation = currentUserHistory.history.slice(1);
                    const truncatedConversation = conversation.slice(Math.max(0, conversation.length - (MAX_CONVERSATION_MESSAGES_STORED - 1)));
                    currentUserHistory.history = [INITIAL_BOT_MESSAGE, ...truncatedConversation];
                } else {
                    currentUserHistory.history = currentUserHistory.history.slice(Math.max(0, currentUserHistory.history.length - MAX_CONVERSATION_MESSAGES_STORED));
                }
            }
            chatHistories.set(chatId, currentUserHistory);
        }

        const responsePayload = {
            reply: finalUserVisibleReply,
            chat_id: chatId,
            right: isCorrectGuess,
            gameOver: gameOver,
            gameOverReason: gameOverReason
        };

        return new Response(JSON.stringify(responsePayload), {
            headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        });

    } catch (error) {
        console.error('Critical error in handleChatRequest:', error);
        return new Response(JSON.stringify({ detail: '服务器发生严重内部错误，请稍后再试。' }), {
            status: 500, headers: { 'Content-Type': 'application/json;charset=UTF-8' }
        });
    }
}