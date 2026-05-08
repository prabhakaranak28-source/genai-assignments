import express from 'express'
import fetch from 'node-fetch'
import https from 'https'
import { RadarGenerateSchema, RadarGenerateResponseSchema, TestableRequirementRequestSchema, TestableRequirementResponseSchema } from '../schemas'
import { buildRadarPrompt, buildRadarSystemPrompt, buildTestableRequirementPrompt, buildTestableRequirementSystemPrompt } from '../prompt'
import { callKiroCli, validateKiroCliAuth } from '../llm/kiroCliClient'

export const radarRouter = express.Router()

const httpsAgent = new https.Agent({ rejectUnauthorized: false })

function extractFromHtml(html: string, cardId: string): { cardId: string; subject: string; description: string } | null {
  let subject = ''
  let description = ''

  const titleMatch = html.match(/<title[^>]*>[^#]*#\d+[:\s]+([^<\-]+)/i)
  if (titleMatch) subject = titleMatch[1].trim()

  if (!subject) {
    const subjectDiv = html.match(/<div[^>]+class="[^"]*subject[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    if (subjectDiv) subject = subjectDiv[1].replace(/<[^>]+>/g, '').trim()
  }
  if (!subject) {
    const h2 = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)
    if (h2) subject = h2[1].replace(/<[^>]+>/g, '').trim()
  }

  const wikiMatch = html.match(/<div[^>]+(?:class="[^"]*wiki[^"]*"|id="[^"]*description[^"]*")[^>]*>([\s\S]*?)<\/div>/i)
  if (wikiMatch) {
    description = wikiMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }

  if (!subject) return null
  return { cardId, subject, description }
}

radarRouter.get('/auth/validate', async (_req: express.Request, res: express.Response): Promise<void> => {
  const isValid = await validateKiroCliAuth()
  if (isValid) {
    res.json({ authenticated: true })
  } else {
    res.status(401).json({ authenticated: false, error: 'Kiro CLI not authenticated. Run kiro-cli login first.' })
  }
})

radarRouter.get('/card/:cardId', async (req: express.Request, res: express.Response): Promise<void> => {
  const { cardId } = req.params
  const authToken = (req.headers['x-radar-token'] as string || '').trim()
  const radarUrl = (req.headers['x-radar-url'] as string || '').trim()

  if (!authToken || !radarUrl) {
    res.status(400).json({ error: 'Missing x-radar-token or x-radar-url header' })
    return
  }

  const baseUrl = radarUrl.replace(/\/$/, '')
  const url = `${baseUrl}/issues/${cardId}`

  const radarHeaders: Record<string, string> = {
    'Accept': '*/*',
    'X-Redmine-API-Key': authToken,
  }

  try {
    const response = await fetch(url, { headers: radarHeaders, agent: httpsAgent })
    const bodyText = await response.text()

    if (response.status === 401) {
      res.status(401).json({ error: 'Invalid Radar API key.' })
      return
    }
    if (response.status === 403) {
      res.status(403).json({ error: `Access denied to card #${cardId}.` })
      return
    }
    if (response.status === 404) {
      res.status(404).json({ error: `Card #${cardId} not found.` })
      return
    }
    if (!response.ok) {
      res.status(response.status).json({ error: `Radar returned HTTP ${response.status}` })
      return
    }

    if (bodyText.trim().startsWith('{')) {
      try {
        const d = JSON.parse(bodyText)
        const iss = d?.issue
        if (iss) {
          res.json({ cardId, subject: iss.subject || '', description: iss.description || '' })
          return
        }
      } catch { /* fall through to HTML */ }
    }

    if (bodyText.includes('<html') || bodyText.includes('<title')) {
      const parsed = extractFromHtml(bodyText, cardId)
      if (parsed) {
        res.json(parsed)
        return
      }
    }

    res.status(404).json({ error: `Could not extract data from card #${cardId}.` })
  } catch (err) {
    res.status(502).json({ error: `Network error: ${(err as Error).message}` })
  }
})

radarRouter.post('/testable-requirement', async (req: express.Request, res: express.Response): Promise<void> => {
  const validation = TestableRequirementRequestSchema.safeParse(req.body)
  if (!validation.success) {
    res.status(400).json({ error: validation.error.message })
    return
  }

  const { description } = validation.data
  const systemPrompt = buildTestableRequirementSystemPrompt()
  const userPrompt = buildTestableRequirementPrompt(description)
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`

  try {
    const output = await callKiroCli(fullPrompt)

    let parsed: any
    try {
      parsed = JSON.parse(output)
    } catch {
      const jsonMatch = output.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0])
        } catch {
          res.status(502).json({ error: 'Kiro CLI returned invalid JSON', raw: output })
          return
        }
      } else {
        res.status(502).json({ error: 'Kiro CLI returned invalid JSON', raw: output })
        return
      }
    }

    const responseValidation = TestableRequirementResponseSchema.safeParse(parsed)
    if (!responseValidation.success) {
      res.status(502).json({ error: 'Kiro CLI response schema mismatch', raw: output })
      return
    }

    res.json(responseValidation.data)
  } catch (err) {
    res.status(502).json({ error: (err as Error).message })
  }
})

radarRouter.post('/generate', async (req: express.Request, res: express.Response): Promise<void> => {
  const validation = RadarGenerateSchema.safeParse(req.body)
  if (!validation.success) {
    res.status(400).json({ error: validation.error.message })
    return
  }

  const { cardId, subject, description, testableRequirement, testTypes } = validation.data
  const systemPrompt = buildRadarSystemPrompt(testTypes)
  const userPrompt = buildRadarPrompt(cardId, subject, description, testableRequirement, testTypes)
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`

  try {
    const output = await callKiroCli(fullPrompt)

    let parsed: any
    try {
      parsed = JSON.parse(output)
    } catch {
      const jsonMatch = output.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0])
        } catch {
          res.status(502).json({ error: 'Kiro CLI returned invalid JSON', raw: output.substring(0, 500) })
          return
        }
      } else {
        res.status(502).json({ error: 'Kiro CLI returned invalid JSON', raw: output.substring(0, 500) })
        return
      }
    }

    const responseValidation = RadarGenerateResponseSchema.safeParse({
      cases: parsed.cases,
      cardId,
      subject,
      model: 'kiro-cli',
      promptTokens: 0,
      completionTokens: 0
    })

    if (!responseValidation.success) {
      res.status(502).json({ error: 'Kiro CLI response schema mismatch' })
      return
    }

    res.json(responseValidation.data)
  } catch (err) {
    res.status(502).json({ error: (err as Error).message })
  }
})
