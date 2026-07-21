export const CONFIG_KEY = 'x-karing-diversion'

export const MATCHER_TYPES = [
  ['DOMAIN-SUFFIX', '域名后缀'],
  ['DOMAIN', '完整域名'],
  ['DOMAIN-KEYWORD', '域名关键词'],
  ['DOMAIN-REGEX', '域名正则'],
  ['IP-CIDR', 'IP CIDR'],
  ['DST-PORT', '目标端口'],
  ['NETWORK', '协议'],
  ['GEOSITE', 'GeoSite'],
  ['GEOIP', 'GeoIP'],
  ['RULE-SET', 'Rule Set'],
  ['RULE-SET-BUILDIN', 'Rule Set(build-in)'],
  ['PROCESS-NAME', '进程名称'],
  ['PROCESS-P