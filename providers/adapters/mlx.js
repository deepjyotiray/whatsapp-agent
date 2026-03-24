"use strict"

const http = require("http")
const BaseAdapter = require("./base")

class MLXAdapter extends BaseAdapter {
    async complete(input, options = {}) {
        const port = this.config.port || process.env.MLX_PORT || 5001
        const hostname = this.config.hostname || '127.0.0.1'
        
        const prompt = typeof input === 'string' ? input : input.map(m => `${m.role}: ${m.content}`).join("\n")
        
        const postData = JSON.stringify({
            prompt: prompt,
            max_tokens: options.max_tokens || this.config.max_tokens || 1000,
            temp: options.temperature ?? this.config.temperature ?? 0.7,
            stop: options.stop || this.config.stop || []
        })

        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname,
                port,
                path: '/generate',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                },
                timeout: 120000
            }, (res) => {
                let data = ''
                res.on('data', (chunk) => { data += chunk })
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data)
                        if (json.error) throw new Error(json.error)
                        resolve((json.response || "").trim())
                    } catch (e) {
                        reject(e)
                    }
                })
            })
            
            req.on('error', (e) => reject(new Error(`MLX request error: ${e.message}`)))
            req.on('timeout', () => {
                req.destroy()
                reject(new Error("MLX request timeout"))
            })
            
            req.write(postData)
            req.end()
        })
    }
}

module.exports = MLXAdapter
