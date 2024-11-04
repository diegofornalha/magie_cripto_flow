import { NextRequest, NextResponse } from "next/server";
// Initialize Swarm with your API key
import {
    Swarm
} from "@pluralityai/agents";
import { z } from "zod";

import { SendTokenAgent } from "../../../agents";
import { loadIntent } from "../../../lib/intents"
import { ETHAddress, getChainByName, getTokenDetails } from "@/lib/utils";
import { constructBundleRequest, triggerBundleRoute } from "@/lib/enso";

const swarm = new Swarm(process.env.OPEN_API_KEY);

export async function GET() {

    const data = {}

    return Response.json({ data })
}


const Schema = z.object({
    query: z.string(),
    account: z.string(),
    chain: z.string()
});


const agents = ["prepareTransaction", "prepareSwapTransaction", "prepareBridgeTransaction"]
const agentIntent: { [x: string]: string} = {
    "prepareTransaction": "send",
    "prepareSwapTransaction": "swap",
    "prepareBridgeTransaction": "bridge"
}

export async function POST(request: NextRequest) {
    const body = await request.json();
    const data = Schema.parse(body)
    const { query } = data
    const messages = [{ role: "user", content: query }];

    try {

        const agent = SendTokenAgent
        const response = await swarm.run({
            agent: agent,
            messages,
        }) as { messages: { content: string, role: string, tool_call_id?: string, tool_name?: string }[] }


        const actions = response.messages.filter((message) => message.tool_name && agents.includes(message.tool_name)).map((m) => ({ ...m, content: JSON.parse(m.content) }))


        const actionExpand = []
        const chain = data.chain


        for (const action of actions) {
            if (action.tool_name) {
                const intent = agentIntent[action.tool_name]

                // eslint-disable-next-line
                let payload: { [x: string]: any } = {
                    type: intent,
                    tool: action.tool_name
                }


                if (action.tool_name == "prepareTransaction") {
                    const token = {
                        symbol: action.content.token,
                        address: getTokenDetails(action.content.token, Number(chain))?.address
                    }

                    const receiverAddress = new ETHAddress(action.content.receiver)
                    await receiverAddress.resolve()

                    const receiver = receiverAddress.hex || action.content.receiver
                    payload = {
                        ...payload,
                        amount: action.content.amount,
                        receiver: receiver,
                        token
                    }
                } else if (action.tool_name == "prepareSwapTransaction") {

                    const tokenIn = {
                        symbol: action.content.tokenIn,
                        address: getTokenDetails(action.content.tokenIn, Number(chain))?.address
                    }
                    const tokenOut = {
                        symbol: action.content.tokenOut,
                        address: getTokenDetails(action.content.tokenOut, Number(chain))?.address
                    }
                    payload = {
                        ...payload,
                        amount: action.content.amount,
                        tokenIn: tokenIn,
                        tokenOut: tokenOut,
                    }
                }
                else if (action.tool_name == "prepareBridgeTransaction") {

                    const _chain = getChainByName(action.content.fromChain)?.chainId

                    const fromChain = {
                        name: action.content.fromChain,
                        chain_id: _chain
                    }
                    const toChain = {
                        name: action.content.toChain,
                        chain_id: getChainByName(action.content.toChain)?.chainId
                    }
                    const token = {
                        symbol: action.content.token,
                        address: getTokenDetails(action.content.token, Number(_chain))?.address
                    }
                    payload = {
                        ...payload,
                        amount: action.content.amount,
                        fromChain,
                        toChain,
                        token,
                    }


                }

                const txIntent = loadIntent({ ...payload })

                const txData = await txIntent.buildTransaction({ chain_id: Number(data.chain) }, data.account)

                actionExpand.push({
                    ...action,
                    txData,
                    resolved: payload
                })

            }
        }

        // eslint-disable-next-line
        let bundleList: any = actionExpand.map((a) => ({ content: a.resolved, type: a.tool_name }))

        bundleList = await constructBundleRequest(bundleList);

        let bundleTx

        if (bundleList.length) {
            bundleTx = await triggerBundleRoute({ chainId: Number(chain), fromAddress: data.account }, bundleList)
        }

        const message = response.messages[response.messages.length - 1].content;


        return NextResponse.json({ actions: actionExpand, message: message, bundleTx });
    } catch (error) {
        console.error("Error:", error);
        return NextResponse.json(
            { error: "An error occurred while processing your request." },
            { status: 500 }
        );
    }

}