export type MetadataFieldType = 'text' | 'textarea'

export interface HistoryMetadataField {
  key: string
  label: string
  type: MetadataFieldType
  required?: boolean
  placeholder?: string
}

export interface HistoryDocTypeConfig {
  value: string
  label: string
  formatType: string
  icon: string
  description: string
  fields: HistoryMetadataField[]
}

export interface HistoryCitationTemplateSeed {
  id: string
  style_id: string
  name: string
  format_type: string
  template_text: string
  field_mappings: string
  is_default: number
}

export const HISTORY_CITATION_STYLE_ID = 'style_history_research_notes'
export const HISTORY_CITATION_SEED_VERSION = 'history-research-notes-2026-05'

export const HISTORY_CITATION_STYLE = {
  id: HISTORY_CITATION_STYLE_ID,
  name: '《历史研究》注释体例',
  description: '按《历史研究》引文注释规定生成脚注式引文，按文献类型自动匹配模板。',
  is_default: 1,
}

export const CITATION_FORMAT_LABELS: Record<string, string> = {
  monograph: '专著',
  collection_article: '析出文献',
  preface: '序跋/前言/后记',
  guji_blockprint: '古籍刻本',
  guji_collated: '古籍点校整理本',
  guji_facsimile: '古籍影印本',
  guji_collection_article: '古籍析出文献',
  local_gazetteer: '地方志',
  classic: '常用典籍',
  journal: '期刊论文',
  newspaper: '报纸',
  thesis: '学位论文',
  conference: '会议论文',
  archive: '档案/手稿',
  secondary: '转引文献',
  online: '电子文献',
  english_monograph: '英文专著',
  english_translation: '英文译著',
  english_journal: '英文期刊',
  english_collection: '英文文集析出',
  english_archive: '英文档案',
  'GB-T7714': 'GB/T 7714',
  APA: 'APA',
  MLA: 'MLA',
  Chicago: 'Chicago',
  Custom: '自定义',
}

export const CITATION_FORMAT_ORDER = [
  'monograph',
  'collection_article',
  'preface',
  'guji_blockprint',
  'guji_collated',
  'guji_facsimile',
  'guji_collection_article',
  'local_gazetteer',
  'classic',
  'journal',
  'newspaper',
  'thesis',
  'conference',
  'archive',
  'secondary',
  'online',
  'english_monograph',
  'english_translation',
  'english_journal',
  'english_collection',
  'english_archive',
  'GB-T7714',
  'APA',
  'MLA',
  'Chicago',
  'IEEE',
  'Custom',
]

export const CITATION_FORMAT_COLORS: Record<string, string> = {
  monograph: 'blue',
  collection_article: 'geekblue',
  preface: 'purple',
  guji_blockprint: 'gold',
  guji_collated: 'gold',
  guji_facsimile: 'gold',
  guji_collection_article: 'gold',
  local_gazetteer: 'orange',
  classic: 'orange',
  journal: 'green',
  newspaper: 'volcano',
  thesis: 'purple',
  conference: 'cyan',
  archive: 'cyan',
  secondary: 'magenta',
  online: 'blue',
  english_monograph: 'blue',
  english_translation: 'purple',
  english_journal: 'green',
  english_collection: 'cyan',
  english_archive: 'cyan',
  'GB-T7714': 'red',
  APA: 'blue',
  MLA: 'green',
  Chicago: 'orange',
  Custom: 'default',
}

export const CITATION_PLACEHOLDER_LABELS: Record<string, string> = {
  author: '责任者',
  responsibility: '责任方式',
  title: '文献题名',
  translator: '译者',
  editor: '编者',
  book_author: '文集责任者',
  book_responsibility: '文集责任方式',
  book_title: '文集题名',
  publish_place: '出版地点',
  publisher: '出版者',
  publication_year: '出版年份',
  publication_time: '出版时间',
  year: '年份',
  date: '形成/出版日期',
  pages: '页码',
  page_reference: '页码标注',
  volume: '卷号',
  issue: '期号',
  volume_issue: '卷期',
  issue_date: '年期/出版年月',
  journal: '期刊名',
  newspaper: '报纸名称',
  edition_info: '版次/栏目',
  source: '来源',
  version: '版本',
  volume_info: '卷次/册次',
  chapter: '篇名/部类',
  page_side: '叶面',
  column: '栏位',
  series: '丛书项',
  series_volume: '丛书册次',
  collection: '藏所/馆藏单位',
  archive_id: '卷宗号/档号',
  location: '地点/学校',
  degree_type: '论文性质',
  university: '学校/授予单位',
  meeting_name: '会议名称',
  url: '获取和访问路径',
  access_date: '引用日期',
  update_date: '更新/修改日期',
  medium: '电子文献载体',
  original_author: '原责任者',
  original_title: '原文献题名',
  original_source: '原文献版本信息',
  original_pages: '原页码/卷期',
  cite_author: '转引责任者',
  cite_title: '转引文献题名',
  cite_source: '转引版本信息',
  cite_pages: '转引页码',
  doi: 'DOI',
  isbn: 'ISBN',
  issn: 'ISSN',
  key: '引文键',
}

export const CITATION_SAMPLE_DOC: Record<string, string> = {
  author: '赵景深',
  responsibility: '',
  title: '文坛忆旧',
  translator: '谭汝谦、林启彦',
  editor: '王宁、薛晓源',
  book_author: '王宁、薛晓源',
  book_responsibility: '编',
  book_title: '全球化与后殖民批评',
  publish_place: '上海',
  publisher: '北新书局',
  publication_year: '1948',
  publication_time: '1948 年',
  year: '1948',
  date: '1986 年 8 月 22 日',
  pages: '43',
  page_reference: '第 43 页',
  volume: '4',
  issue: '3',
  volume_issue: '第 4 卷第 6 期',
  issue_date: '1998 年第 3 期',
  journal: '中国史研究',
  newspaper: '四川工人日报',
  edition_info: '第 2 版',
  source: '故宫博物院藏',
  version: '光绪三年苏州文学山房活字本',
  volume_info: '卷 3',
  chapter: '《服章部七》',
  page_side: 'a',
  column: '下栏',
  series: '《四库全书存目丛书》',
  series_volume: '子部，第 88 册',
  collection: '中国第二历史档案馆藏',
  archive_id: '北洋档案 1011-5961',
  location: '北京师范大学历史系',
  degree_type: '博士学位论文',
  university: '北京师范大学历史系',
  meeting_name: '全球化与亚太区域化国际研讨会',
  url: 'http://www.cajcd.cn/pub/wml.txt/980810-2.html',
  access_date: '1998 年 10 月 4 日',
  update_date: '1998 年 8 月 16 日',
  medium: '网络版',
  original_author: '章太炎',
  original_title: '在长沙晨光学校演说',
  original_source: '1925 年 10 月',
  original_pages: '',
  cite_author: '汤志钧',
  cite_title: '章太炎年谱长编',
  cite_source: '下册，北京：中华书局，1979 年',
  cite_pages: '第 823 页',
  doi: '10.1000/example',
  isbn: '978-7-101-00000-0',
  issn: '1001-0000',
  key: 'zhaojingshen1948',
}

export const HISTORY_CITATION_TEMPLATE_DEFAULTS: Record<string, string> = {
  monograph: '{{author}}{{responsibility}}：《{{title}}》{{volume_info}}，{{publish_place}}：{{publisher}}，{{publication_time}}，{{page_reference}}。',
  collection_article: '{{author}}：《{{title}}》，{{book_author}}{{book_responsibility}}：《{{book_title}}》，{{publish_place}}：{{publisher}}，{{publication_time}}，{{page_reference}}。',
  preface: '{{author}}：《{{title}}》，{{publish_place}}：{{publisher}}，{{publication_time}}，“{{chapter}}”，{{page_reference}}。',
  guji_blockprint: '{{author}}{{responsibility}}：《{{title}}》{{volume_info}}{{chapter}}，{{version}}，{{page_reference}}{{page_side}}。',
  guji_collated: '{{author}}{{responsibility}}：《{{title}}》{{volume_info}}{{chapter}}，{{publish_place}}：{{publisher}}，{{publication_time}}，{{version}}，{{page_reference}}。',
  guji_facsimile: '{{author}}{{responsibility}}：《{{title}}》{{volume_info}}{{chapter}}，{{publish_place}}：{{publisher}}，{{publication_time}}影印本，{{volume_info}}，{{page_reference}}{{column}}。',
  guji_collection_article: '{{author}}：《{{title}}》，{{book_title}}{{volume_info}}，{{series}}，{{publish_place}}：{{publisher}}，{{publication_time}}影印本，{{series_volume}}，{{page_reference}}。',
  local_gazetteer: '{{title}}{{volume_info}}{{chapter}}，{{series}}，{{publish_place}}：{{publisher}}，{{publication_time}}影印本，{{series_volume}}，{{page_reference}}{{page_side}}。',
  classic: '《{{title}}》{{volume_info}}{{chapter}}，{{publish_place}}：{{publisher}}，{{publication_time}}，{{version}}，{{page_reference}}。',
  journal: '{{author}}：《{{title}}》，《{{journal}}》{{issue_date}}。',
  newspaper: '{{author}}：《{{title}}》，《{{newspaper}}》{{date}}，{{edition_info}}。',
  thesis: '{{author}}：《{{title}}》，{{degree_type}}，{{university}}，{{publication_time}}，{{page_reference}}。',
  conference: '{{author}}：《{{title}}》，{{meeting_name}}论文，{{location}}，{{date}}，{{page_reference}}。',
  archive: '《{{title}}》，{{date}}，{{archive_id}}，{{collection}}。',
  secondary: '{{original_author}}：《{{original_title}}》，{{original_source}}，{{original_pages}}，转引自{{cite_author}}：《{{cite_title}}》，{{cite_source}}，{{cite_pages}}。',
  online: '{{author}}：《{{title}}》，{{update_date}}，{{url}}，{{access_date}}。',
  english_monograph: '{{author}}, {{title}}, {{publish_place}}: {{publisher}}, {{publication_year}}, {{page_reference}}.',
  english_translation: '{{author}}, {{title}}, trans. by {{translator}}, {{publish_place}}: {{publisher}}, {{publication_year}}, {{page_reference}}.',
  english_journal: '{{author}}, "{{title}}," {{journal}}, vol. {{volume}}, no. {{issue}} ({{date}}), {{page_reference}}.',
  english_collection: '{{author}}, "{{title}}," in {{editor}}, eds., {{book_title}}, {{publish_place}}: {{publisher}}, {{publication_year}}, {{page_reference}}.',
  english_archive: '{{title}}, {{date}}, {{archive_id}}, {{collection}}.',
  'GB-T7714': '{{author}}. {{title}}[M]. {{publish_place}}: {{publisher}}, {{publication_year}}.',
  APA: '{{author}} ({{publication_year}}). {{title}}. {{journal}}, {{volume}}({{issue}}), {{pages}}.',
  MLA: '{{author}}. "{{title}}." {{journal}}, vol. {{volume}}, no. {{issue}}, {{publication_year}}, pp. {{pages}}.',
  Chicago: '{{author}}. "{{title}}." {{journal}} {{volume}}, no. {{issue}} ({{publication_year}}): {{pages}}.',
  Custom: '',
}

export const DEFAULT_HISTORY_CITATION_TEMPLATES: HistoryCitationTemplateSeed[] = CITATION_FORMAT_ORDER.map((formatType, index) => ({
  id: `cit_history_${formatType}`,
  style_id: HISTORY_CITATION_STYLE_ID,
  name: `《历史研究》 / ${CITATION_FORMAT_LABELS[formatType] || formatType}`,
  format_type: formatType,
  template_text: HISTORY_CITATION_TEMPLATE_DEFAULTS[formatType],
  field_mappings: '{}',
  is_default: index === 0 ? 1 : 0,
}))

const COMMON_RESEARCH_FIELDS: HistoryMetadataField[] = [
  { key: 'abstract', label: '内容摘要', type: 'textarea' },
  { key: 'keywords', label: '关键词', type: 'text', placeholder: '多个关键词用逗号、顿号或分号分隔' },
]

export const HISTORY_DOC_TYPE_CONFIGS: HistoryDocTypeConfig[] = [
  {
    value: '专著',
    label: '专著',
    formatType: 'monograph',
    icon: '专',
    description: '顺序：责任者与责任方式 / 文献题名 / 出版地点 / 出版者 / 出版时间 / 页码。',
    fields: [
      { key: 'responsibility', label: '责任方式', type: 'text', placeholder: '著可省略；主编、整理等不可省略' },
      { key: 'translator', label: '译者', type: 'text' },
      { key: 'volume_info', label: '卷册信息', type: 'text', placeholder: '如：上册、第 31 卷' },
      { key: 'publish_place', label: '出版地点', type: 'text' },
      { key: 'publisher', label: '出版者', type: 'text' },
      { key: 'publication_year', label: '出版年份', type: 'text', placeholder: '如：1948；不详可填 [出版时间不详]' },
      { key: 'pages', label: '引证页码', type: 'text', placeholder: '如：43 或 11-12' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '析出文献',
    label: '析出文献',
    formatType: 'collection_article',
    icon: '析',
    description: '顺序：责任者 / 析出文献题名 / 文集责任者与责任方式 / 文集题名 / 出版信息 / 页码。',
    fields: [
      { key: 'book_author', label: '文集责任者', type: 'text' },
      { key: 'book_responsibility', label: '文集责任方式', type: 'text', placeholder: '如：编、主编、整理' },
      { key: 'book_title', label: '文集题名', type: 'text' },
      { key: 'publish_place', label: '出版地点', type: 'text' },
      { key: 'publisher', label: '出版者', type: 'text' },
      { key: 'publication_year', label: '出版年份', type: 'text' },
      { key: 'pages', label: '引证页码', type: 'text' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '序跋/前言/后记',
    label: '序跋/前言/后记',
    formatType: 'preface',
    icon: '序',
    description: '有单独标题时可按析出文献处理；无单独标题时注明“序言”“前言”等部位。',
    fields: [
      { key: 'chapter', label: '序跋部位或标题', type: 'text', placeholder: '如：序言；读家书，想傅雷（代序）' },
      { key: 'book_author', label: '著作/文集责任者', type: 'text' },
      { key: 'book_title', label: '著作/文集题名', type: 'text' },
      { key: 'publish_place', label: '出版地点', type: 'text' },
      { key: 'publisher', label: '出版者', type: 'text' },
      { key: 'publication_year', label: '出版年份', type: 'text' },
      { key: 'pages', label: '引证页码', type: 'text' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '古籍刻本',
    label: '古籍刻本',
    formatType: 'guji_blockprint',
    icon: '刻',
    description: '顺序：责任者与责任方式 / 题名（卷次、篇名、部类） / 版本 / 页码；页码注明 a、b 面。',
    fields: [
      { key: 'responsibility', label: '责任方式', type: 'text' },
      { key: 'volume_info', label: '卷次/册次', type: 'text', placeholder: '如：卷 3' },
      { key: 'chapter', label: '篇名/部类', type: 'text', placeholder: '如：《郡县志二·广州府·城池》' },
      { key: 'version', label: '版本', type: 'text', placeholder: '如：光绪三年苏州文学山房活字本' },
      { key: 'pages', label: '页码', type: 'text', placeholder: '如：9' },
      { key: 'page_side', label: '叶面', type: 'text', placeholder: 'a 或 b' },
      { key: 'source', label: '馆藏来源', type: 'text' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '古籍点校整理本',
    label: '古籍点校整理本',
    formatType: 'guji_collated',
    icon: '校',
    description: '顺序：责任者与责任方式 / 题名 / 卷次篇名 / 出版地点 / 出版者 / 出版时间 / 页码；可注明标点本、整理本。',
    fields: [
      { key: 'responsibility', label: '责任方式', type: 'text' },
      { key: 'volume_info', label: '卷次/册次', type: 'text' },
      { key: 'chapter', label: '篇名/部类', type: 'text' },
      { key: 'publish_place', label: '出版地点', type: 'text' },
      { key: 'publisher', label: '出版者', type: 'text' },
      { key: 'publication_year', label: '出版年份', type: 'text' },
      { key: 'version', label: '整理说明', type: 'text', placeholder: '如：标点本、整理本' },
      { key: 'pages', label: '引证页码', type: 'text' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '古籍影印本',
    label: '古籍影印本',
    formatType: 'guji_facsimile',
    icon: '影',
    description: '顺序：责任者与责任方式 / 题名 / 卷次篇名 / 出版地点 / 出版者 / 出版时间 / 影印页码；可标明栏位。',
    fields: [
      { key: 'responsibility', label: '责任方式', type: 'text' },
      { key: 'volume_info', label: '卷次/册次', type: 'text', placeholder: '如：卷 5，上册，第 3 册' },
      { key: 'chapter', label: '篇名/部类', type: 'text' },
      { key: 'publish_place', label: '出版地点', type: 'text' },
      { key: 'publisher', label: '出版者', type: 'text' },
      { key: 'publication_year', label: '出版年份', type: 'text' },
      { key: 'pages', label: '影印页码', type: 'text' },
      { key: 'column', label: '栏位', type: 'text', placeholder: '如：上栏、下栏' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '古籍析出文献',
    label: '古籍析出文献',
    formatType: 'guji_collection_article',
    icon: '古',
    description: '顺序：责任者 / 析出文献题名 / 文集题名 / 卷次 / 丛书项 / 版本或出版信息 / 页码。',
    fields: [
      { key: 'book_title', label: '文集题名', type: 'text' },
      { key: 'volume_info', label: '卷次', type: 'text' },
      { key: 'series', label: '丛书项', type: 'text' },
      { key: 'publish_place', label: '出版地点', type: 'text' },
      { key: 'publisher', label: '出版者', type: 'text' },
      { key: 'publication_year', label: '出版年份', type: 'text' },
      { key: 'series_volume', label: '丛书册次/部类', type: 'text' },
      { key: 'pages', label: '引证页码', type: 'text' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '地方志',
    label: '地方志',
    formatType: 'local_gazetteer',
    icon: '志',
    description: '明清以后一般不标作者；书名前冠修纂年代，民国地方志冠“民国”。',
    fields: [
      { key: 'volume_info', label: '卷次', type: 'text' },
      { key: 'chapter', label: '篇名/部类', type: 'text' },
      { key: 'series', label: '丛书项', type: 'text' },
      { key: 'publish_place', label: '出版地点', type: 'text' },
      { key: 'publisher', label: '出版者', type: 'text' },
      { key: 'publication_year', label: '出版年份', type: 'text' },
      { key: 'series_volume', label: '册次', type: 'text' },
      { key: 'pages', label: '页码', type: 'text' },
      { key: 'page_side', label: '叶面', type: 'text', placeholder: 'a 或 b' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '常用典籍',
    label: '常用典籍',
    formatType: 'classic',
    icon: '典',
    description: '常用基本典籍、官修大型典籍及书名含作者姓名的文集可不标注作者。',
    fields: [
      { key: 'volume_info', label: '卷次/册次', type: 'text' },
      { key: 'chapter', label: '篇名/部类/年月甲子', type: 'text' },
      { key: 'publish_place', label: '出版地点', type: 'text' },
      { key: 'publisher', label: '出版者', type: 'text' },
      { key: 'publication_year', label: '出版年份', type: 'text' },
      { key: 'version', label: '版本说明', type: 'text', placeholder: '如：标点本、影印本' },
      { key: 'pages', label: '引证页码', type: 'text' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '期刊论文',
    label: '期刊论文',
    formatType: 'journal',
    icon: '刊',
    description: '顺序：责任者 / 文献题名 / 期刊名 / 年期或卷期、出版年月。',
    fields: [
      { key: 'journal', label: '期刊名', type: 'text' },
      { key: 'issue_date', label: '年期/卷期/出版年月', type: 'text', placeholder: '如：1998 年第 3 期；第 28 卷第 1 期，1976 年 1 月' },
      { key: 'volume', label: '卷号', type: 'text' },
      { key: 'issue', label: '期号', type: 'text' },
      { key: 'publication_year', label: '发表年份', type: 'text' },
      { key: 'pages', label: '页码范围', type: 'text' },
      { key: 'doi', label: 'DOI', type: 'text' },
      { key: 'issn', label: 'ISSN', type: 'text' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '报纸',
    label: '报纸',
    formatType: 'newspaper',
    icon: '报',
    description: '顺序：责任者 / 篇名 / 报纸名称 / 出版年月日 / 版次；早期报纸可填卷册、栏目、页码。',
    fields: [
      { key: 'newspaper', label: '报纸名称', type: 'text' },
      { key: 'date', label: '出版年月日', type: 'text' },
      { key: 'edition_info', label: '版次/卷册/栏目', type: 'text' },
      { key: 'pages', label: '页码', type: 'text' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '学位论文',
    label: '学位论文',
    formatType: 'thesis',
    icon: '学',
    description: '顺序：责任者 / 文献标题 / 论文性质 / 学校或地点 / 文献形成时间 / 页码。',
    fields: [
      { key: 'degree_type', label: '论文性质', type: 'text', placeholder: '如：博士学位论文、硕士学位论文' },
      { key: 'university', label: '学校/院系', type: 'text' },
      { key: 'publication_year', label: '形成年份', type: 'text' },
      { key: 'pages', label: '引证页码', type: 'text' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '会议论文',
    label: '会议论文',
    formatType: 'conference',
    icon: '会',
    description: '顺序：责任者 / 文献标题 / 会议论文性质 / 地点 / 文献形成时间 / 页码。',
    fields: [
      { key: 'meeting_name', label: '会议名称', type: 'text' },
      { key: 'location', label: '地点', type: 'text' },
      { key: 'date', label: '形成时间', type: 'text' },
      { key: 'pages', label: '引证页码', type: 'text' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '档案/手稿',
    label: '档案/手稿',
    formatType: 'archive',
    icon: '档',
    description: '顺序：文献标题 / 文献形成时间 / 卷宗号或其他编号 / 藏所。',
    fields: [
      { key: 'date', label: '文献形成时间', type: 'text' },
      { key: 'archive_id', label: '卷宗号/档号', type: 'text' },
      { key: 'collection', label: '藏所', type: 'text' },
      { key: 'source', label: '来源说明', type: 'text' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '转引文献',
    label: '转引文献',
    formatType: 'secondary',
    icon: '转',
    description: '无法直接引用时使用；须标明原文献信息与转引文献信息。',
    fields: [
      { key: 'original_author', label: '原责任者', type: 'text' },
      { key: 'original_title', label: '原文献题名', type: 'text' },
      { key: 'original_source', label: '原文献版本信息', type: 'text' },
      { key: 'original_pages', label: '原页码/卷期', type: 'text' },
      { key: 'cite_author', label: '转引责任者', type: 'text' },
      { key: 'cite_title', label: '转引文献题名', type: 'text' },
      { key: 'cite_source', label: '转引版本信息', type: 'text' },
      { key: 'cite_pages', label: '转引页码', type: 'text' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '电子文献',
    label: '电子文献',
    formatType: 'online',
    icon: '电',
    description: '顺序：责任者 / 电子文献题名 / 更新或修改日期 / 获取和访问路径 / 引用日期。',
    fields: [
      { key: 'update_date', label: '更新或修改日期', type: 'text' },
      { key: 'url', label: '获取和访问路径', type: 'text' },
      { key: 'access_date', label: '引用日期', type: 'text' },
      { key: 'journal', label: '网络刊物名', type: 'text' },
      { key: 'issue_date', label: '年期', type: 'text' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '外文专著',
    label: '外文专著',
    formatType: 'english_monograph',
    icon: 'En',
    description: '英文专著按通行英文注释方式标注：Author, Title, Place: Publisher, Year, pages.',
    fields: [
      { key: 'publish_place', label: 'Place', type: 'text' },
      { key: 'publisher', label: 'Publisher', type: 'text' },
      { key: 'publication_year', label: 'Year', type: 'text' },
      { key: 'pages', label: 'Pages', type: 'text' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '外文译著',
    label: '外文译著',
    formatType: 'english_translation',
    icon: '译',
    description: '英文译著顺序：Author / Title / Translator / Place / Publisher / Year / pages。',
    fields: [
      { key: 'translator', label: 'Translator', type: 'text' },
      { key: 'publish_place', label: 'Place', type: 'text' },
      { key: 'publisher', label: 'Publisher', type: 'text' },
      { key: 'publication_year', label: 'Year', type: 'text' },
      { key: 'pages', label: 'Pages', type: 'text' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '外文期刊论文',
    label: '外文期刊论文',
    formatType: 'english_journal',
    icon: 'Ej',
    description: '英文期刊析出：Author, “Title,” Journal, vol., no. (date), pages.',
    fields: [
      { key: 'journal', label: 'Journal', type: 'text' },
      { key: 'volume', label: 'Volume', type: 'text' },
      { key: 'issue', label: 'Issue', type: 'text' },
      { key: 'date', label: 'Date', type: 'text' },
      { key: 'pages', label: 'Pages', type: 'text' },
      { key: 'doi', label: 'DOI', type: 'text' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '外文文集析出',
    label: '外文文集析出',
    formatType: 'english_collection',
    icon: 'Ec',
    description: '英文文集析出：Author, “Title,” in Editor, eds., Book Title, Place: Publisher, Year, pages.',
    fields: [
      { key: 'editor', label: 'Editor', type: 'text' },
      { key: 'book_title', label: 'Book Title', type: 'text' },
      { key: 'publish_place', label: 'Place', type: 'text' },
      { key: 'publisher', label: 'Publisher', type: 'text' },
      { key: 'publication_year', label: 'Year', type: 'text' },
      { key: 'pages', label: 'Pages', type: 'text' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '外文档案',
    label: '外文档案',
    formatType: 'english_archive',
    icon: 'Ea',
    description: '英文档案顺序：Document title, date, file number, repository.',
    fields: [
      { key: 'date', label: 'Date', type: 'text' },
      { key: 'archive_id', label: 'File number', type: 'text' },
      { key: 'collection', label: 'Repository', type: 'text' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
  {
    value: '其他',
    label: '其他',
    formatType: 'monograph',
    icon: '文',
    description: '无法归类时先按专著字段管理，可在引用格式中手动调整。',
    fields: [
      { key: 'source', label: '来源', type: 'text' },
      { key: 'date', label: '日期', type: 'text' },
      { key: 'publish_place', label: '出版地点', type: 'text' },
      { key: 'publisher', label: '出版者', type: 'text' },
      { key: 'publication_year', label: '年份', type: 'text' },
      { key: 'pages', label: '页码', type: 'text' },
      ...COMMON_RESEARCH_FIELDS,
    ],
  },
]

export const HISTORY_DOC_TYPE_OPTIONS = HISTORY_DOC_TYPE_CONFIGS.map((item) => item.value)

export const LEGACY_DOC_TYPE_MAP: Record<string, string> = {
  图书: '专著',
  书籍: '专著',
  档案: '档案/手稿',
  手稿: '档案/手稿',
  报告: '其他',
  book: '专著',
  monograph: '专著',
  thesis: '学位论文',
  dissertation: '学位论文',
  conference: '会议论文',
  newspaper: '报纸',
  archive: '档案/手稿',
}

export function normalizeHistoryDocType(docType: string | null | undefined): string {
  const text = String(docType || '').trim()
  if (!text || text === 'unknown') return '其他'
  if (HISTORY_DOC_TYPE_OPTIONS.includes(text)) return text

  const mapped = LEGACY_DOC_TYPE_MAP[text] || LEGACY_DOC_TYPE_MAP[text.toLowerCase()]
  if (mapped) return mapped

  const normalized = text.toLowerCase()
  if (/学位|博士|硕士|thesis|dissertation/.test(normalized)) return '学位论文'
  if (/会议|conference/.test(normalized)) return '会议论文'
  if (/报纸|newspaper/.test(normalized)) return '报纸'
  if (/档案|手稿|archive|manuscript/.test(normalized)) return '档案/手稿'
  if (/书|专著|图书|book|monograph|epub/.test(normalized)) return '专著'
  if (/影印/.test(normalized)) return '古籍影印本'
  if (/点校|整理|标点/.test(normalized)) return '古籍点校整理本'
  if (/地方志|县志|府志|通志/.test(normalized)) return '地方志'
  if (/常用典籍|二十四史|资治通鉴|实录|四库全书|论语/.test(normalized)) return '常用典籍'
  if (/刻本|活字本|抄本|钞本/.test(normalized)) return '古籍刻本'
  return text
}

export const HISTORY_DOC_TYPE_ICON_MAP: Record<string, string> = Object.fromEntries(
  HISTORY_DOC_TYPE_CONFIGS.map((item) => [item.value, item.icon]),
)

export const HISTORY_METADATA_TEMPLATES: Record<string, HistoryMetadataField[]> = Object.fromEntries(
  HISTORY_DOC_TYPE_CONFIGS.map((item) => [item.value, item.fields]),
)

export function getHistoryDocTypeConfig(docType: string | null | undefined): HistoryDocTypeConfig {
  return HISTORY_DOC_TYPE_CONFIGS.find((item) => item.value === docType)
    || HISTORY_DOC_TYPE_CONFIGS.find((item) => item.value === '其他')
    || HISTORY_DOC_TYPE_CONFIGS[0]
}

export function getHistoryMetadataFields(docType: string | null | undefined): HistoryMetadataField[] {
  return getHistoryDocTypeConfig(docType).fields
}

export function mapDocTypeToHistoryCitationFormat(docType: string | null | undefined): string {
  const text = normalizeHistoryDocType(docType)
  const direct = HISTORY_DOC_TYPE_CONFIGS.find((item) => item.value === text)
  if (direct) return direct.formatType

  const normalized = text.toLowerCase()
  if (/析出|文集/.test(text)) return 'collection_article'
  if (/序|跋|前言|后记/.test(text)) return 'preface'
  if (/地方志|县志|府志|通志/.test(text)) return 'local_gazetteer'
  if (/常用典籍|二十四史|资治通鉴|实录|四库全书|论语/.test(text)) return 'classic'
  if (/影印/.test(text)) return 'guji_facsimile'
  if (/点校|整理|标点/.test(text)) return 'guji_collated'
  if (/刻本|活字本|抄本|钞本/.test(text)) return 'guji_blockprint'
  if (/学位|博士|硕士|thesis|dissertation/.test(normalized)) return 'thesis'
  if (/会议|研讨会|conference/.test(normalized)) return 'conference'
  if (/报纸|newspaper/.test(normalized)) return 'newspaper'
  if (/档案|手稿|archive|manuscript/.test(normalized)) return 'archive'
  if (/转引|secondary/.test(normalized)) return 'secondary'
  if (/电子|网络|网页|online|web|url/.test(normalized)) return 'online'
  if (/英文.*译|translation/.test(normalized)) return 'english_translation'
  if (/英文.*期刊|english.*journal/.test(normalized)) return 'english_journal'
  if (/英文.*文集|english.*collection/.test(normalized)) return 'english_collection'
  if (/英文.*档案|english.*archive/.test(normalized)) return 'english_archive'
  if (/英文|english/.test(normalized)) return 'english_monograph'
  if (/期刊|学报|journal|periodical/.test(normalized)) return 'journal'
  if (/书|专著|图书|电子书|book|monograph|epub|txt|pdf/.test(normalized)) return 'monograph'
  return 'monograph'
}
