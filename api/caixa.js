export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { estado = 'PR' } = req.query;
  const estados = ['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA',
                   'MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN',
                   'RO','RR','RS','SC','SE','SP','TO'];
  if (!estados.includes(estado.toUpperCase())) {
    return res.status(400).json({ error: 'Estado inválido' });
  }

  const uf = estado.toUpperCase();
  const csvUrl = `https://venda-imoveis.caixa.gov.br/listaweb/Lista_imoveis_${uf}.csv`;

  try {
    const response = await fetch(csvUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Referer': 'https://venda-imoveis.caixa.gov.br/sistema/busca-imovel.asp',
        'Origin': 'https://venda-imoveis.caixa.gov.br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return res.status(response.status).json({ 
        error: `Caixa HTTP ${response.status}`, url: csvUrl 
      });
    }

    const buffer = await response.arrayBuffer();
    const text = new TextDecoder('iso-8859-1').decode(buffer);

    if (text.trim().startsWith('<!') || text.trim().startsWith('<html')) {
      return res.status(403).json({ 
        error: 'Caixa retornou HTML — IP do Vercel bloqueado',
        hint: 'Tente novamente em alguns minutos'
      });
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=1800');
    return res.status(200).send(text);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
