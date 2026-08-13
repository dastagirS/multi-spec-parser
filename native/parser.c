#include <node_api.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <errno.h>
#include <math.h>
#ifdef _WIN32
#define strcasecmp _stricmp
#define strncasecmp _strnicmp
#else
#include <strings.h>
#endif

#define NY_MAX_INPUT_BYTES (200u * 1024u * 1024u)
#define NY_MAX_LINES (2000000u)
#define NY_MAX_NODES (2000000u)
#define NY_MAX_DEPTH (1024u)
#define NY_MAX_FLOW_DEPTH (256u)
#define NY_MAX_STACK (2000000u)

typedef enum { NY_NULL, NY_BOOL, NY_NUMBER, NY_STRING, NY_MAP, NY_SEQUENCE } NyType;
typedef struct NyNode NyNode;
typedef struct { char *key; NyNode *value; } NyPair;
struct NyNode {
  NyType type;
  union {
    bool boolean;
    double number;
    struct { char *value; size_t length; } string;
    struct { NyPair *items; size_t count; size_t capacity; } map;
    struct { NyNode **items; size_t count; size_t capacity; } sequence;
  } data;
};
typedef struct { char *text; char *raw; size_t length; size_t indent; bool blank; } NyLine;
typedef struct { NyLine *lines; size_t count; size_t capacity; size_t index; size_t nodes; size_t max_nodes; size_t max_depth; size_t depth; char error[256]; } NyParser;
typedef struct { NyNode *node; size_t indent; bool sequence; } NyFrame;
typedef struct { NyNode *container; char closing; bool map; unsigned state; char *pending_key; } NyFlowFrame;

static bool ny_fail(NyParser *parser, const char *message) {
  if (parser == NULL || message == NULL) return false;
  if (parser->error[0] == '\0') snprintf(parser->error, sizeof(parser->error), "%s", message);
  return false;
}

static bool ny_range(bool condition, NyParser *parser, const char *message) {
  if (condition) return true;
  return ny_fail(parser, message);
}

static char *ny_copy(const char *source, size_t length) {
  if (source == NULL || length > SIZE_MAX - 1) return NULL;
  char *copy = malloc(length + 1);
  if (copy == NULL) return NULL;
  memcpy(copy, source, length);
  copy[length] = '\0';
  return copy;
}

static void ny_free_node(NyNode *root) {
  if (root == NULL) return;
  size_t capacity = 64;
  NyNode **stack = malloc(sizeof(*stack) * capacity);
  if (stack == NULL) return;
  size_t count = 1;
  stack[0] = root;
  while (count > 0) {
    NyNode *node = stack[--count];
    if (node->type == NY_MAP) {
      for (size_t index = 0; index < node->data.map.count; index++) {
        free(node->data.map.items[index].key);
        if (count == capacity) {
          if (capacity >= NY_MAX_STACK) { free(stack); return; }
          size_t next_capacity = capacity * 2;
          NyNode **grown = realloc(stack, sizeof(*stack) * next_capacity);
          if (grown == NULL) { free(stack); return; }
          stack = grown;
          capacity = next_capacity;
        }
        stack[count++] = node->data.map.items[index].value;
      }
      free(node->data.map.items);
    } else if (node->type == NY_SEQUENCE) {
      for (size_t index = 0; index < node->data.sequence.count; index++) {
        if (count == capacity) {
          if (capacity >= NY_MAX_STACK) { free(stack); return; }
          size_t next_capacity = capacity * 2;
          NyNode **grown = realloc(stack, sizeof(*stack) * next_capacity);
          if (grown == NULL) { free(stack); return; }
          stack = grown;
          capacity = next_capacity;
        }
        stack[count++] = node->data.sequence.items[index];
      }
      free(node->data.sequence.items);
    } else if (node->type == NY_STRING) {
      free(node->data.string.value);
    }
    free(node);
  }
  free(stack);
}

static NyNode *ny_node(NyParser *parser, NyType type) {
  if (parser == NULL || parser->nodes >= parser->max_nodes) { ny_fail(parser, "node count limit exceeded"); return NULL; }
  NyNode *node = calloc(1, sizeof(*node));
  if (node == NULL) { ny_fail(parser, "out of memory"); return NULL; }
  node->type = type;
  parser->nodes++;
  return node;
}

static bool ny_map_add(NyParser *parser, NyNode *map, char *key, NyNode *value) {
  if (parser == NULL || map == NULL || key == NULL || value == NULL) return ny_fail(parser, "invalid mapping entry");
  if (map->type != NY_MAP) return ny_fail(parser, "mapping parent required");
  if (map->data.map.count == map->data.map.capacity) {
    size_t capacity = map->data.map.capacity == 0 ? 8 : map->data.map.capacity * 2;
    if (capacity < map->data.map.count || capacity > NY_MAX_NODES) return ny_fail(parser, "mapping is too large");
    NyPair *items = realloc(map->data.map.items, capacity * sizeof(*items));
    if (items == NULL) return ny_fail(parser, "out of memory");
    map->data.map.items = items; map->data.map.capacity = capacity;
  }
  map->data.map.items[map->data.map.count++] = (NyPair){key, value};
  return true;
}

static bool ny_sequence_add(NyParser *parser, NyNode *sequence, NyNode *value) {
  if (parser == NULL || sequence == NULL || value == NULL) return ny_fail(parser, "invalid sequence entry");
  if (sequence->type != NY_SEQUENCE) return ny_fail(parser, "sequence parent required");
  if (sequence->data.sequence.count == sequence->data.sequence.capacity) {
    size_t capacity = sequence->data.sequence.capacity == 0 ? 8 : sequence->data.sequence.capacity * 2;
    if (capacity < sequence->data.sequence.count || capacity > NY_MAX_NODES) return ny_fail(parser, "sequence is too large");
    NyNode **items = realloc(sequence->data.sequence.items, capacity * sizeof(*items));
    if (items == NULL) return ny_fail(parser, "out of memory");
    sequence->data.sequence.items = items; sequence->data.sequence.capacity = capacity;
  }
  sequence->data.sequence.items[sequence->data.sequence.count++] = value;
  return true;
}

static bool ny_quote_may_start(const char *source, size_t index) {
  if (source == NULL) return false;
  if (index == 0) return true;
  size_t previous = index;
  while (previous > 0 && isspace((unsigned char)source[previous - 1])) previous--;
  if (previous == 0) return true;
  char character = source[previous - 1];
  if (character == ':' || character == ',' || character == '[' || character == '{') return true;
  if (character != '-') return false;
  for (size_t cursor = 0; cursor + 1 < previous; cursor++) if (!isspace((unsigned char)source[cursor])) return false;
  return true;
}

static char *ny_strip_comment(const char *source, size_t length, char *quote_state) {
  if (source == NULL || quote_state == NULL) return NULL;
  char quote = *quote_state;
  for (size_t index = 0; index < length; index++) {
    char character = source[index];
    if (quote == '\'' && character == '\'' && index + 1 < length && source[index + 1] == '\'') { index++; continue; }
    if (quote == '\'' && character == '\'') { quote = 0; continue; }
    if (quote == '"' && character == '\\') { if (index + 1 < length) index++; continue; }
    if (quote == '"' && character == '"') { quote = 0; continue; }
    if (quote == 0 && (character == '\'' || character == '"') && ny_quote_may_start(source, index)) { quote = character; continue; }
    if (quote == 0 && character == '#' && (index == 0 || isspace((unsigned char)source[index - 1]))) length = index;
  }
  *quote_state = quote;
  while (length > 0 && (source[length - 1] == ' ' || source[length - 1] == '\t')) length--;
  return ny_copy(source, length);
}

static bool ny_block_header(const char *source, size_t length) {
  if (source == NULL || length == 0) return false;
  for (size_t index = 0; index < length; index++) {
    if (source[index] != ':' || (index + 1 < length && !isspace((unsigned char)source[index + 1]))) continue;
    size_t value = index + 1;
    while (value < length && isspace((unsigned char)source[value])) value++;
    return value < length && (source[value] == '|' || source[value] == '>');
  }
  return false;
}

static bool ny_lines(NyParser *parser, const char *text, size_t length) {
  if (parser == NULL || text == NULL) return false;
  if (!ny_range(length <= NY_MAX_INPUT_BYTES, parser, "input is too large")) return false;
  size_t position = 0;
  char quote_state = 0; size_t block_parent_indent = SIZE_MAX;
  if (length >= 3 && (unsigned char)text[0] == 0xef && (unsigned char)text[1] == 0xbb && (unsigned char)text[2] == 0xbf) position = 3;
  while (position <= length) {
    size_t end = position;
    while (end < length && text[end] != '\n' && text[end] != '\r') end++;
    size_t raw_end = end;
    size_t indent = 0;
    while (position + indent < raw_end && text[position + indent] == ' ') indent++;
    if (position + indent < raw_end && text[position + indent] == '\t') return ny_fail(parser, "tab indentation is not supported");
    size_t line_length = raw_end - position - indent;
    bool block_content = block_parent_indent != SIZE_MAX && (line_length == 0 || indent > block_parent_indent);
    if (block_parent_indent != SIZE_MAX && !block_content) block_parent_indent = SIZE_MAX;
    char *raw = ny_copy(text + position + indent, line_length);
    char *content = block_content ? ny_copy(text + position + indent, line_length) : ny_strip_comment(text + position + indent, line_length, &quote_state);
    if (raw == NULL || content == NULL) { free(raw); free(content); return ny_fail(parser, "out of memory"); }
    if (parser->count == parser->capacity) {
      size_t capacity = parser->capacity == 0 ? 128 : parser->capacity * 2;
      NyLine *lines = realloc(parser->lines, capacity * sizeof(*lines));
      if (lines == NULL) { free(content); return ny_fail(parser, "out of memory"); }
      parser->lines = lines; parser->capacity = capacity;
    }
    parser->lines[parser->count++] = (NyLine){content, raw, strlen(content), indent, content[0] == '\0'};
    if (parser->count > NY_MAX_LINES) return ny_fail(parser, "line count limit exceeded");
    if (!block_content && block_parent_indent == SIZE_MAX && ny_block_header(content, strlen(content))) { block_parent_indent = indent; quote_state = 0; }
    if (end == length) break;
    position = end + 1;
    if (text[end] == '\r' && position < length && text[position] == '\n') position++;
  }
  return true;
}

static void ny_trim(const char **source, size_t *length) {
  while (*length > 0 && isspace((unsigned char)(*source)[0])) { (*source)++; (*length)--; }
  while (*length > 0 && isspace((unsigned char)(*source)[*length - 1])) (*length)--;
}

static bool ny_find_colon(const char *source, size_t length, bool flow, size_t *colon) {
  if (source == NULL || colon == NULL) return false;
  char quote = 0; unsigned depth = 0;
  for (size_t index = 0; index < length; index++) {
    char character = source[index];
    if (quote == '\'' && character == '\'' && index + 1 < length && source[index + 1] == '\'') { index++; continue; }
    if (quote == '\'' && character == '\'') { quote = 0; continue; }
    if (quote == '"' && character == '\\') { if (index + 1 < length) index++; continue; }
    if (quote == '"' && character == '"') { quote = 0; continue; }
    if (quote == 0 && (character == '\'' || character == '"')) {
      size_t previous = index;
      while (previous > 0 && isspace((unsigned char)source[previous - 1])) previous--;
      bool starts_quote = ny_quote_may_start(source, index);
      if (starts_quote) { quote = character; continue; }
    }
    if (quote == 0 && (character == '[' || character == '{')) { depth++; continue; }
    if (quote == 0 && (character == ']' || character == '}')) { if (depth == 0) return false; depth--; continue; }
    if (quote == 0 && depth == 0 && character == ':' && (flow || index + 1 == length || isspace((unsigned char)source[index + 1]))) { *colon = index; return true; }
  }
  return false;
}

static bool ny_double_quote_complete(const char *source, size_t length);

static bool ny_decode_double(NyParser *parser, const char *source, size_t length, char **out, size_t *out_length) {
  if (parser == NULL || source == NULL || out == NULL || out_length == NULL || length < 2 || source[0] != '"' || source[length - 1] != '"' || !ny_double_quote_complete(source, length)) return ny_fail(parser, "invalid double quote");
  char *result = malloc(length);
  if (result == NULL) return ny_fail(parser, "out of memory");
  size_t count = 0;
  for (size_t index = 1; index + 1 < length; index++) {
    char character = source[index];
    if (character != '\\') { result[count++] = character; continue; }
    if (++index + 1 > length) { free(result); return ny_fail(parser, "unterminated escape"); }
    character = source[index];
    if (character == '\n' || character == '\r') { continue; }
    if (character == '0') { result[count++] = '\0'; continue; }
    if (character == 'a') { result[count++] = '\a'; continue; }
    if (character == 'b') { result[count++] = '\b'; continue; }
    if (character == 't') { result[count++] = '\t'; continue; }
    if (character == 'n') { result[count++] = '\n'; continue; }
    if (character == 'v') { result[count++] = '\v'; continue; }
    if (character == 'f') { result[count++] = '\f'; continue; }
    if (character == 'r') { result[count++] = '\r'; continue; }
    if (character == 'e') { result[count++] = 0x1b; continue; }
    if (character == ' ') { result[count++] = ' '; continue; }
    if (character == '"' || character == '\\' || character == '/') { result[count++] = character; continue; }
    if (character == 'x' || character == 'u' || character == 'U') {
      size_t digits = character == 'x' ? 2 : character == 'u' ? 4 : 8;
      uint32_t code = 0;
      if (index + digits >= length) { free(result); return ny_fail(parser, "short unicode escape"); }
      for (size_t digit = 0; digit < digits; digit++) {
        char hex = source[++index]; int value = isdigit((unsigned char)hex) ? hex - '0' : (hex >= 'a' && hex <= 'f') ? hex - 'a' + 10 : (hex >= 'A' && hex <= 'F') ? hex - 'A' + 10 : -1;
        if (value < 0) { free(result); return ny_fail(parser, "invalid unicode escape"); }
        code = code * 16u + (uint32_t)value;
      }
      if (code >= 0xd800u && code <= 0xdbffu) {
        size_t low_start = index + 3;
        if (low_start + 3 >= length || source[index + 1] != '\\' || source[index + 2] != 'u') { free(result); return ny_fail(parser, "high surrogate requires low surrogate"); }
        uint32_t low = 0;
        for (size_t digit = 0; digit < 4; digit++) {
          char hex = source[low_start + digit]; int value = isdigit((unsigned char)hex) ? hex - '0' : (hex >= 'a' && hex <= 'f') ? hex - 'a' + 10 : (hex >= 'A' && hex <= 'F') ? hex - 'A' + 10 : -1;
          if (value < 0) { free(result); return ny_fail(parser, "invalid low surrogate"); }
          low = low * 16u + (uint32_t)value;
        }
        if (low < 0xdc00u || low > 0xdfffu) { free(result); return ny_fail(parser, "high surrogate requires low surrogate"); }
        code = 0x10000u + ((code - 0xd800u) << 10) + (low - 0xdc00u); index = low_start + 3;
      } else if (code >= 0xdc00u && code <= 0xdfffu) { free(result); return ny_fail(parser, "unexpected low surrogate"); }
      if (code <= 0x7fu) result[count++] = (char)code;
      else if (code <= 0x7ffu) { result[count++] = (char)(0xc0u | (code >> 6)); result[count++] = (char)(0x80u | (code & 0x3fu)); }
      else if (code <= 0xffffu) { result[count++] = (char)(0xe0u | (code >> 12)); result[count++] = (char)(0x80u | ((code >> 6) & 0x3fu)); result[count++] = (char)(0x80u | (code & 0x3fu)); }
      else if (code <= 0x10ffffu) { result[count++] = (char)(0xf0u | (code >> 18)); result[count++] = (char)(0x80u | ((code >> 12) & 0x3fu)); result[count++] = (char)(0x80u | ((code >> 6) & 0x3fu)); result[count++] = (char)(0x80u | (code & 0x3fu)); }
      else { free(result); return ny_fail(parser, "unicode code point out of range"); }
      continue;
    }
    free(result); return ny_fail(parser, "unsupported escape");
  }
  result[count] = '\0'; *out = result; *out_length = count; return true;
}

static bool ny_parse_scalar(NyParser *parser, const char *source, size_t length, NyNode **out) {
  if (parser == NULL || source == NULL || out == NULL) return false;
  ny_trim(&source, &length);
  if (length > 0 && (source[0] == '&' || source[0] == '*' || source[0] == '!')) return ny_fail(parser, "anchors, aliases, and tags are unsupported");
  if (length == 0 || (length == 1 && source[0] == '~') || (length == 4 && strncasecmp(source, "null", 4) == 0)) { *out = ny_node(parser, NY_NULL); return *out != NULL; }
  if (length == 4 && strncasecmp(source, "true", 4) == 0) { *out = ny_node(parser, NY_BOOL); if (*out) (*out)->data.boolean = true; return *out != NULL; }
  if (length == 5 && strncasecmp(source, "false", 5) == 0) { *out = ny_node(parser, NY_BOOL); if (*out) (*out)->data.boolean = false; return *out != NULL; }
  if (length >= 2 && source[0] == '"') { char *value = NULL; size_t value_length = 0; if (!ny_decode_double(parser, source, length, &value, &value_length)) return false; *out = ny_node(parser, NY_STRING); if (*out == NULL) { free(value); return false; } (*out)->data.string.value = value; (*out)->data.string.length = value_length; return true; }
  if (length >= 2 && source[0] == '\'') {
    if (source[length - 1] != '\'') return ny_fail(parser, "unterminated single quote");
    char *value = malloc(length);
    if (value == NULL) return ny_fail(parser, "out of memory");
    size_t count = 0; for (size_t index = 1; index + 1 < length; index++) { value[count++] = source[index]; if (source[index] == '\'' && index + 1 < length - 1 && source[index + 1] == '\'') index++; }
    value[count] = '\0'; *out = ny_node(parser, NY_STRING); if (*out == NULL) { free(value); return false; } (*out)->data.string.value = value; (*out)->data.string.length = count; return true;
  }
  char *plain = ny_copy(source, length); if (plain == NULL) return ny_fail(parser, "out of memory");
  bool looks_numeric = (plain[0] >= '0' && plain[0] <= '9') || ((plain[0] == '+' || plain[0] == '-') && plain[1] >= '0' && plain[1] <= '9') || (plain[0] == '.' && plain[1] >= '0' && plain[1] <= '9');
  for (size_t read_index = 0; looks_numeric && read_index < strlen(plain); read_index++) { char character = plain[read_index]; bool allowed = isdigit((unsigned char)character) || character == '_' || character == '+' || character == '-' || character == '.' || character == 'e' || character == 'E' || character == 'x' || character == 'X' || character == 'o' || character == 'O' || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F'); if (!allowed) looks_numeric = false; }
  if (looks_numeric) { size_t plain_length = strlen(plain); size_t write_index = 0; for (size_t read_index = 0; read_index < plain_length; read_index++) if (plain[read_index] != '_') plain[write_index++] = plain[read_index]; plain[write_index] = '\0'; }
  char *end = NULL; errno = 0; double number = strtod(plain, &end);
  bool numeric_shape = (plain[0] >= '0' && plain[0] <= '9') || ((plain[0] == '+' || plain[0] == '-') && plain[1] >= '0' && plain[1] <= '9') || (plain[0] == '.' && plain[1] >= '0' && plain[1] <= '9');
  bool numeric = numeric_shape && end != plain && *end == '\0' && errno != ERANGE;
  if (numeric_shape && (strncasecmp(plain, "0o", 2) == 0 || strncasecmp(plain, "+0o", 3) == 0 || strncasecmp(plain, "-0o", 3) == 0)) { char *octal = plain + (plain[0] == '+' || plain[0] == '-' ? 3 : 2); number = (double)strtoul(octal, &end, 8); numeric = end != octal && *end == '\0'; if (plain[0] == '-') number = -number; }
  if (!numeric && numeric_shape) { end = NULL; errno = 0; number = strtod(plain, &end); numeric = end != plain && *end == '\0' && errno != ERANGE; }
  if (strcasecmp(plain, ".inf") == 0 || strcasecmp(plain, "+.inf") == 0) { number = INFINITY; numeric = true; }
  if (strcasecmp(plain, "-.inf") == 0) { number = -INFINITY; numeric = true; }
  if (strcasecmp(plain, ".nan") == 0) { number = NAN; numeric = true; }
  if (numeric) { free(plain); *out = ny_node(parser, NY_NUMBER); if (*out) (*out)->data.number = number; return *out != NULL; }
  *out = ny_node(parser, NY_STRING); if (*out == NULL) { free(plain); return false; } (*out)->data.string.value = plain; (*out)->data.string.length = strlen(plain); return true;
}

static bool ny_flow_scan(const char *source, size_t length, char *closings, size_t *depth, char *quote) {
  if (source == NULL || closings == NULL || depth == NULL || quote == NULL) return false;
  for (size_t index = 0; index < length; index++) {
    char character = source[index];
    if (*quote == '\'' && character == '\'' && index + 1 < length && source[index + 1] == '\'') { index++; continue; }
    if (*quote == '\'' && character == '\'') { *quote = 0; continue; }
    if (*quote == '"' && character == '\\') { if (index + 1 < length) index++; continue; }
    if (*quote == '"' && character == '"') { *quote = 0; continue; }
    if (*quote == 0 && (character == '\'' || character == '"') && ny_quote_may_start(source, index)) { *quote = character; continue; }
    if (*quote == 0 && (character == '[' || character == '{')) {
      if (*depth >= NY_MAX_FLOW_DEPTH) return false;
      closings[(*depth)++] = character == '[' ? ']' : '}';
      continue;
    }
    if (*quote == 0 && (character == ']' || character == '}')) {
      if (*depth == 0 || closings[*depth - 1] != character) return false;
      (*depth)--;
    }
  }
  return true;
}

static bool ny_split_flow(const char *source, size_t length, size_t *end) {
  if (source == NULL || end == NULL) return false;
  char closings[NY_MAX_FLOW_DEPTH]; char quote = 0; size_t depth = 0;
  if (!ny_flow_scan(source, length, closings, &depth, &quote) || quote != 0) return false;
  *end = depth; return true;
}

static bool ny_parse_flow(NyParser *parser, const char *source, size_t length, NyNode **out) {
  if (parser == NULL || source == NULL || out == NULL || length < 2) return false;
  size_t end = 0; if (!ny_split_flow(source, length, &end) || end != 0) return ny_fail(parser, "Flow nesting or syntax invalid");
  NyFlowFrame *frames = calloc(NY_MAX_FLOW_DEPTH, sizeof(*frames)); if (frames == NULL) return ny_fail(parser, "out of memory");
  size_t frame_count = 0; size_t cursor = 0; NyNode *root = NULL;
  while (cursor < length || frame_count > 0) {
    while (cursor < length && isspace((unsigned char)source[cursor])) cursor++;
    if (frame_count == 0 && root != NULL) break;
    if (frame_count > 0) {
      NyFlowFrame *frame = &frames[frame_count - 1];
      if (cursor < length && source[cursor] == frame->closing && frame->state == 0) { cursor++; free(frame->pending_key); frame_count--; continue; }
      if (cursor < length && source[cursor] == frame->closing && frame->state == 3) { cursor++; free(frame->pending_key); frame_count--; continue; }
      if (cursor < length && source[cursor] == ',' && frame->state == 3) { cursor++; frame->state = 0; continue; }
      if (frame->state == 1) {
        if (cursor >= length || source[cursor++] != ':') { free(frames); return ny_fail(parser, "flow mapping requires colon"); }
        frame->state = 2; continue;
      }
      if (frame->state == 0 || (frame->map && frame->state == 2)) {
        if (cursor >= length) { free(frames); return ny_fail(parser, "flow collection is not closed"); }
        if (source[cursor] == '[' || source[cursor] == '{') {
          char opener = source[cursor++]; NyNode *child = ny_node(parser, opener == '[' ? NY_SEQUENCE : NY_MAP); if (child == NULL) { free(frames); return false; }
          if (frame->map) { if (frame->pending_key != NULL) { if (!ny_map_add(parser, frame->container, frame->pending_key, child)) { free(frames); return false; } frame->pending_key = NULL; frame->state = 3; } else { frame->pending_key = NULL; frame->state = 1; } }
          else { if (!ny_sequence_add(parser, frame->container, child)) { free(frames); return false; } frame->state = 3; }
          if (frame_count >= parser->max_depth || frame_count >= NY_MAX_FLOW_DEPTH) { free(frames); return ny_fail(parser, "flow nesting limit exceeded"); }
          frames[frame_count++] = (NyFlowFrame){child, opener == '[' ? ']' : '}', opener == '{', 0, NULL}; continue;
        }
        size_t start = cursor; char quote = 0;
        while (cursor < length) { char character = source[cursor]; if (quote == 0 && (character == ',' || character == ']' || character == '}' || (frame->map && character == ':'))) break; if (quote == '\'' && character == '\'' && cursor + 1 < length && source[cursor + 1] == '\'') { cursor += 2; continue; } if (quote == '"' && character == '\\') { cursor += 2; continue; } if (quote == 0 && (character == '\'' || character == '"') && ny_quote_may_start(source, cursor)) quote = character; else if (quote != 0 && character == quote) quote = 0; cursor++; }
        if (quote != 0 || cursor == start) { free(frames); return ny_fail(parser, "invalid flow scalar"); }
        NyNode *value = NULL; if (!ny_parse_scalar(parser, source + start, cursor - start, &value)) { free(frames); return false; }
        if (frame->map) { if (frame->pending_key != NULL) { if (!ny_map_add(parser, frame->container, frame->pending_key, value)) { free(frames); return false; } frame->pending_key = NULL; frame->state = 3; } else { if (value->type != NY_STRING) { ny_free_node(value); free(frames); return ny_fail(parser, "flow mapping key must be scalar text"); } frame->pending_key = ny_copy(value->data.string.value, value->data.string.length); ny_free_node(value); if (frame->pending_key == NULL) { free(frames); return ny_fail(parser, "out of memory"); } frame->state = 1; } }
        else { if (!ny_sequence_add(parser, frame->container, value)) { free(frames); return false; } frame->state = 3; }
        continue;
      }
      free(frames); return ny_fail(parser, "invalid flow state");
    }
    if (cursor >= length || (source[cursor] != '[' && source[cursor] != '{')) { free(frames); return ny_fail(parser, "flow value must start with collection"); }
    char opener = source[cursor++]; root = ny_node(parser, opener == '[' ? NY_SEQUENCE : NY_MAP); if (root == NULL) { free(frames); return false; }
    frames[frame_count++] = (NyFlowFrame){root, opener == '[' ? ']' : '}', opener == '{', 0, NULL};
  }
  free(frames); if (root == NULL || cursor < length) { ny_free_node(root); return ny_fail(parser, "invalid flow value"); } *out = root; return true;
}

static bool ny_is_flow(const char *source, size_t length) { return length > 0 && (source[0] == '[' || source[0] == '{'); }

static bool ny_double_quote_complete(const char *source, size_t length) {
  if (source == NULL || length < 1 || source[0] != '"') return false;
  bool escaped = false;
  for (size_t index = 1; index < length; index++) {
    char character = source[index];
    if (escaped) { escaped = false; continue; }
    if (character == '\\') { escaped = true; continue; }
    if (character == '"') return true;
  }
  return false;
}

static bool ny_single_quote_complete(const char *source, size_t length) {
  if (source == NULL || length < 1 || source[0] != '\'') return false;
  for (size_t index = 1; index < length; index++) {
    if (source[index] != '\'') continue;
    if (index + 1 < length && source[index + 1] == '\'') { index++; continue; }
    return true;
  }
  return false;
}

static bool ny_join_single_quoted(NyParser *parser, size_t *line_index, const char *source, size_t length, char **joined, size_t *joined_length) {
  if (parser == NULL || line_index == NULL || source == NULL || joined == NULL || joined_length == NULL) return false;
  if (length == 0 || source[0] != '\'') return ny_fail(parser, "single quote must start a scalar");
  size_t capacity = length + 1; char *result = ny_copy(source, length);
  if (result == NULL) return ny_fail(parser, "out of memory");
  size_t total = length; size_t current = *line_index + 1;
  while (!ny_single_quote_complete(result, total) && current < parser->count) {
    const NyLine *line = &parser->lines[current]; size_t add = line->length;
    size_t needed = total + add + 2;
    if (needed > NY_MAX_INPUT_BYTES) { free(result); return ny_fail(parser, "quoted scalar is too large"); }
    while (capacity < needed) {
      if (capacity > NY_MAX_INPUT_BYTES / 2) { free(result); return ny_fail(parser, "quoted scalar is too large"); }
      capacity *= 2;
    }
    char *grown = realloc(result, capacity);
    if (grown == NULL) { free(result); return ny_fail(parser, "out of memory"); }
    result = grown; result[total++] = line->blank ? '\n' : ' ';
    if (!line->blank) { memcpy(result + total, line->text, add); total += add; }
    current++;
  }
  if (!ny_single_quote_complete(result, total)) { free(result); return ny_fail(parser, "unterminated multiline single quote"); }
  result[total] = '\0'; *line_index = current - 1; *joined = result; *joined_length = total; return true;
}

static bool ny_join_double_quoted(NyParser *parser, size_t *line_index, const char *source, size_t length, char **joined, size_t *joined_length) {
  if (parser == NULL || line_index == NULL || source == NULL || joined == NULL || joined_length == NULL) return false;
  if (length == 0 || source[0] != '"') return ny_fail(parser, "double quote must start a scalar");
  size_t capacity = length + 1; char *result = ny_copy(source, length); if (result == NULL) return ny_fail(parser, "out of memory");
  size_t total = length; size_t current = *line_index + 1;
  while (!ny_double_quote_complete(result, total) && current < parser->count) {
    const NyLine *line = &parser->lines[current]; size_t add = line->length; bool blank = line->blank;
    size_t needed = total + add + 2; if (needed > NY_MAX_INPUT_BYTES) { free(result); return ny_fail(parser, "quoted scalar is too large"); }
    while (capacity < needed) capacity *= 2;
    char *grown = realloc(result, capacity); if (grown == NULL) { free(result); return ny_fail(parser, "out of memory"); }
    result = grown; result[total++] = blank ? '\n' : ' ';
    if (!blank) { memcpy(result + total, line->text, add); total += add; }
    current++;
  }
  if (!ny_double_quote_complete(result, total)) { free(result); return ny_fail(parser, "unterminated multiline double quote"); }
  result[total] = '\0'; *line_index = current - 1; *joined = result; *joined_length = total; return true;
}

static bool ny_block_scalar(NyParser *parser, size_t parent_indent, const char *header, size_t header_length, NyNode **out) {
  if (parser == NULL || header == NULL || out == NULL) return false;
  bool folded = header[0] == '>'; char chomping = 0; size_t explicit_indent = 0;
  for (size_t index = 1; index < header_length; index++) { if (header[index] == '+' || header[index] == '-') chomping = header[index]; if (isdigit((unsigned char)header[index])) explicit_indent = (size_t)(header[index] - '0'); }
  size_t first_indent = SIZE_MAX; size_t start = parser->index + 1;
  for (size_t index = start; index < parser->count; index++) { if (parser->lines[index].blank) continue; if (parser->lines[index].indent <= parent_indent) break; first_indent = parser->lines[index].indent; break; }
  if (first_indent == SIZE_MAX) first_indent = parent_indent + (explicit_indent != 0 ? explicit_indent : 1);
  size_t capacity = 128; char *result = malloc(capacity); if (result == NULL) return ny_fail(parser, "out of memory"); size_t result_length = 0; size_t index = start; bool previous_more_indented = false; size_t folded_blank_lines = 0;
  while (index < parser->count) {
    NyLine *line = &parser->lines[index]; if (!line->blank && line->indent <= parent_indent) break;
    size_t desired_indent = explicit_indent != 0 ? parent_indent + explicit_indent : first_indent; size_t available = strlen(line->raw); const char *content = line->raw; size_t extra_indent = line->indent > desired_indent ? line->indent - desired_indent : 0;
    size_t needed = result_length + extra_indent + available + 2; if (needed > capacity) { while (capacity < needed) capacity *= 2; char *grown = realloc(result, capacity); if (grown == NULL) { free(result); return ny_fail(parser, "out of memory"); } result = grown; }
    if (folded && available == 0) { if (result_length + 1 >= capacity) { capacity *= 2; char *grown = realloc(result, capacity); if (grown == NULL) { free(result); return ny_fail(parser, "out of memory"); } result = grown; } result[result_length++] = '\n'; folded_blank_lines++; index++; continue; }
    bool after_blank = folded && folded_blank_lines > 0;
    if (after_blank && result_length > 0 && result[result_length - 1] == '\n') result_length--;
    if (result_length > 0 && folded && available > 0 && !previous_more_indented && !after_blank && extra_indent == 0 && result[result_length - 1] == '\n' && (result_length < 2 || result[result_length - 2] != '\n') && content[0] != ' ' && content[0] != '\t') result[result_length - 1] = ' ';
    memset(result + result_length, ' ', extra_indent); result_length += extra_indent; memcpy(result + result_length, content, available); result_length += available; result[result_length++] = '\n'; previous_more_indented = extra_indent > 0; folded_blank_lines = 0; index++;
  }
  parser->index = index - 1; if (chomping == '-') { while (result_length > 0 && result[result_length - 1] == '\n') result_length--; } else if (chomping == 0) { while (result_length > 1 && result[result_length - 1] == '\n' && result[result_length - 2] == '\n') result_length--; }
  result[result_length] = '\0'; *out = ny_node(parser, NY_STRING); if (*out == NULL) { free(result); return false; } (*out)->data.string.value = result; (*out)->data.string.length = result_length; return true;
}

static bool ny_next_content(NyParser *parser, size_t from, size_t *index) { if (parser == NULL || index == NULL) return false; for (size_t current = from; current < parser->count; current++) if (!parser->lines[current].blank) { *index = current; return true; } return false; }

static bool ny_inline(NyParser *parser, const char *source, size_t length, NyNode **out) {
  if (parser == NULL || source == NULL || out == NULL) return false;
  ny_trim(&source, &length);
  if (length == 0) return ny_parse_scalar(parser, source, length, out);
  if (source[0] == ']' || source[0] == '}') return ny_fail(parser, "unexpected flow terminator");
  if (ny_is_flow(source, length)) return ny_parse_flow(parser, source, length, out);
  return ny_parse_scalar(parser, source, length, out);
}

static bool ny_choose_child(NyParser *parser, size_t line_index, NyNode **out) {
  size_t next = 0; if (!ny_next_content(parser, line_index, &next)) return false; const char *content = parser->lines[next].text; size_t length = parser->lines[next].length; if (content[0] == '-' && (length == 1 || isspace((unsigned char)content[1]))) *out = ny_node(parser, NY_SEQUENCE); else *out = ny_node(parser, NY_MAP); return *out != NULL;
}

static bool ny_join_flow(NyParser *parser, size_t *line_index, const char *source, size_t length, char **joined, size_t *joined_length) {
  if (parser == NULL || line_index == NULL || source == NULL || joined == NULL || joined_length == NULL) return false;
  char closings[NY_MAX_FLOW_DEPTH]; char quote = 0; size_t depth = 0;
  size_t capacity = length + 1; char *result = ny_copy(source, length);
  if (result == NULL) return ny_fail(parser, "out of memory");
  if (!ny_flow_scan(source, length, closings, &depth, &quote)) { free(result); return ny_fail(parser, "Flow nesting or syntax invalid"); }
  size_t total = length; size_t current = *line_index + 1;
  while ((depth > 0 || quote != 0) && current < parser->count) {
    const NyLine *line = &parser->lines[current];
    size_t add = line->length;
    if (total + add + 1 > NY_MAX_INPUT_BYTES) { free(result); return ny_fail(parser, "flow value is too large"); }
    while (capacity < total + add + 2) {
      if (capacity > NY_MAX_INPUT_BYTES / 2) { free(result); return ny_fail(parser, "flow value is too large"); }
      capacity *= 2;
    }
    char *grown = realloc(result, capacity);
    if (grown == NULL) { free(result); return ny_fail(parser, "out of memory"); }
    result = grown; result[total++] = ' ';
    memcpy(result + total, line->text, add); total += add;
    if (!ny_flow_scan(line->text, add, closings, &depth, &quote)) { free(result); return ny_fail(parser, "Flow nesting or syntax invalid"); }
    current++;
  }
  if (depth != 0 || quote != 0) { free(result); return ny_fail(parser, "flow collection is not closed"); }
  result[total] = '\0'; *line_index = current - 1; *joined = result; *joined_length = total; return true;
}

static bool ny_block(NyParser *parser, NyNode **out) {
  if (parser == NULL || out == NULL) return false;
  size_t first = 0; if (!ny_next_content(parser, 0, &first)) return ny_fail(parser, "YAML document is empty");
  if (parser->lines[first].length == 3 && strncmp(parser->lines[first].text, "---", 3) == 0) {
    if (!ny_next_content(parser, first + 1, &first)) return ny_fail(parser, "YAML document is empty");
    if (parser->lines[first].length == 3 && strncmp(parser->lines[first].text, "---", 3) == 0) return ny_fail(parser, "Multiple YAML documents are unsupported");
  }
  parser->index = first; const char *content = parser->lines[first].text; size_t length = parser->lines[first].length; if (length == 3 && strncmp(content, "...", 3) == 0) return ny_fail(parser, "document end marker before content"); NyNode *root = (content[0] == '-' && (length == 1 || isspace((unsigned char)content[1]))) ? ny_node(parser, NY_SEQUENCE) : ny_node(parser, NY_MAP); if (root == NULL) return false;
  NyFrame *frames = calloc(NY_MAX_DEPTH, sizeof(*frames)); if (frames == NULL) { ny_free_node(root); return ny_fail(parser, "out of memory"); } size_t frame_count = 1; frames[0] = (NyFrame){root, parser->lines[first].indent, root->type == NY_SEQUENCE};
  size_t index = first;
  while (index < parser->count) {
    parser->index = index; NyLine *line = &parser->lines[index]; if (line->blank) { index++; continue; }
    if (line->length == 3 && strncmp(line->text, "---", 3) == 0) { if (index != first) { free(frames); ny_free_node(root); return ny_fail(parser, "Multiple YAML documents are unsupported"); } index++; continue; }
    if (line->length == 3 && strncmp(line->text, "...", 3) == 0) {
      size_t trailing = 0;
      if (ny_next_content(parser, index + 1, &trailing)) { free(frames); ny_free_node(root); return ny_fail(parser, "content after document end marker"); }
      index++; break;
    }
    if (line->text[0] == '%') { free(frames); ny_free_node(root); return ny_fail(parser, "directives are unsupported"); }
    while (frame_count > 1 && line->indent < frames[frame_count - 1].indent) frame_count--;
    if (line->indent != frames[frame_count - 1].indent) { char detail[256]; snprintf(detail, sizeof(detail), "invalid indentation at %zu: got %zu expected %zu (%s)", index, line->indent, frames[frame_count - 1].indent, line->text); free(frames); ny_free_node(root); return ny_fail(parser, detail); }
    NyFrame *frame = &frames[frame_count - 1];
    if (frame->sequence) {
      if (!(line->text[0] == '-' && (line->length == 1 || isspace((unsigned char)line->text[1])))) { free(frames); ny_free_node(root); return ny_fail(parser, "sequence entry expected"); }
      const char *rest = line->text + 1; size_t rest_length = line->length - 1; ny_trim(&rest, &rest_length);
      if (rest_length == 0) {
        size_t next = 0; if (ny_next_content(parser, index + 1, &next) && parser->lines[next].indent > line->indent) { NyNode *child = NULL; if (!ny_choose_child(parser, index + 1, &child) || !ny_sequence_add(parser, frame->node, child)) { free(frames); ny_free_node(root); return false; } if (frame_count >= parser->max_depth) { free(frames); ny_free_node(root); return ny_fail(parser, "nesting limit exceeded"); } frames[frame_count++] = (NyFrame){child, parser->lines[next].indent, child->type == NY_SEQUENCE}; index++; continue; }
        NyNode *null_node = ny_node(parser, NY_NULL); if (null_node == NULL || !ny_sequence_add(parser, frame->node, null_node)) { free(frames); ny_free_node(root); return false; } index++; continue;
      }
      if (rest_length >= 2 && rest[0] == '-' && isspace((unsigned char)rest[1])) {
        NyNode *child = ny_node(parser, NY_SEQUENCE); if (child == NULL || !ny_sequence_add(parser, frame->node, child)) { free(frames); ny_free_node(root); return false; }
        const char *child_rest = rest + 1; size_t child_length = rest_length - 1; ny_trim(&child_rest, &child_length);
        if (child_length == 0) { if (frame_count >= parser->max_depth) { free(frames); ny_free_node(root); return ny_fail(parser, "nesting limit exceeded"); } frames[frame_count++] = (NyFrame){child, line->indent + 2, true}; index++; continue; }
        size_t child_colon = 0;
        if (ny_find_colon(child_rest, child_length, false, &child_colon)) {
          NyNode *map = ny_node(parser, NY_MAP); if (map == NULL || !ny_sequence_add(parser, child, map)) { free(frames); ny_free_node(root); return false; }
          const char *key_source = child_rest; size_t key_length = child_colon; ny_trim(&key_source, &key_length); NyNode *key_node = NULL; if (!ny_parse_scalar(parser, key_source, key_length, &key_node) || key_node->type != NY_STRING) { ny_free_node(key_node); free(frames); ny_free_node(root); return ny_fail(parser, "mapping key must be text"); }
          char *key = ny_copy(key_node->data.string.value, key_node->data.string.length); ny_free_node(key_node); if (key == NULL) { free(frames); ny_free_node(root); return ny_fail(parser, "out of memory"); }
          const char *value_source = child_rest + child_colon + 1; size_t value_length = child_length - child_colon - 1; ny_trim(&value_source, &value_length); NyNode *child_value = NULL;
          if (value_length == 0) child_value = ny_node(parser, NY_NULL); else if (!ny_inline(parser, value_source, value_length, &child_value)) { free(key); free(frames); ny_free_node(root); return false; }
          if (child_value == NULL || !ny_map_add(parser, map, key, child_value)) { free(key); free(frames); ny_free_node(root); return false; }
          size_t continuation_indent = line->indent + 2; size_t next = 0; if (ny_next_content(parser, index + 1, &next) && parser->lines[next].indent > line->indent) continuation_indent = parser->lines[next].indent;
          if (frame_count + 1 >= parser->max_depth) { free(frames); ny_free_node(root); return ny_fail(parser, "nesting limit exceeded"); } frames[frame_count++] = (NyFrame){child, continuation_indent, true}; frames[frame_count++] = (NyFrame){map, continuation_indent, false}; index++; continue;
        }
        NyNode *child_value = NULL; if (!ny_inline(parser, child_rest, child_length, &child_value) || !ny_sequence_add(parser, child, child_value)) { free(frames); ny_free_node(root); return false; }
        if (frame_count >= parser->max_depth) { free(frames); ny_free_node(root); return ny_fail(parser, "nesting limit exceeded"); } frames[frame_count++] = (NyFrame){child, line->indent + 2, true}; index++; continue;
      }
      size_t colon = 0;
      if (ny_find_colon(rest, rest_length, false, &colon)) {
        NyNode *map = ny_node(parser, NY_MAP); if (map == NULL) { free(frames); ny_free_node(root); return false; } if (!ny_sequence_add(parser, frame->node, map)) { free(frames); ny_free_node(root); return false; }
        const char *key_source = rest; size_t key_length = colon; ny_trim(&key_source, &key_length); NyNode *key_node = NULL; if (!ny_parse_scalar(parser, key_source, key_length, &key_node) || key_node->type != NY_STRING) { ny_free_node(key_node); free(frames); ny_free_node(root); return ny_fail(parser, "mapping key must be text"); } char *key = ny_copy(key_node->data.string.value, key_node->data.string.length); ny_free_node(key_node); if (key == NULL) { free(frames); ny_free_node(root); return ny_fail(parser, "out of memory"); }
        const char *value_source = rest + colon + 1; size_t value_length = rest_length - colon - 1; ny_trim(&value_source, &value_length); NyNode *value = NULL;
        if (value_length > 0 && (value_source[0] == '|' || value_source[0] == '>')) { if (!ny_block_scalar(parser, line->indent + 2, value_source, value_length, &value)) { free(key); free(frames); ny_free_node(root); return false; } index = parser->index; }
        else if (value_length == 0) { size_t next = 0; if (ny_next_content(parser, index + 1, &next) && parser->lines[next].indent > line->indent) { if (!ny_choose_child(parser, index + 1, &value)) { free(key); free(frames); ny_free_node(root); return false; } if (frame_count + 1 >= parser->max_depth) { free(key); free(frames); ny_free_node(root); return ny_fail(parser, "nesting limit exceeded"); } frames[frame_count++] = (NyFrame){map, line->indent + 2, false}; frames[frame_count++] = (NyFrame){value, parser->lines[next].indent, value->type == NY_SEQUENCE}; } else value = ny_node(parser, NY_NULL); }
        else { char *joined = NULL; size_t joined_length = 0; if (value_length > 0 && value_source[0] == '\'' && !ny_single_quote_complete(value_source, value_length) && !ny_join_single_quoted(parser, &index, value_source, value_length, &joined, &joined_length)) { free(key); free(frames); ny_free_node(root); return false; } if (joined == NULL && value_length > 0 && value_source[0] == '"' && !ny_double_quote_complete(value_source, value_length) && !ny_join_double_quoted(parser, &index, value_source, value_length, &joined, &joined_length)) { free(key); free(frames); ny_free_node(root); return false; } if (joined == NULL && ny_is_flow(value_source, value_length) && !ny_join_flow(parser, &index, value_source, value_length, &joined, &joined_length)) { free(key); free(frames); ny_free_node(root); return false; } if (joined != NULL) { value = NULL; if (!ny_inline(parser, joined, joined_length, &value)) { free(joined); free(key); free(frames); ny_free_node(root); return false; } free(joined); } else if (!ny_inline(parser, value_source, value_length, &value)) { free(key); free(frames); ny_free_node(root); return false; } }
        if (value == NULL || !ny_map_add(parser, map, key, value)) { free(key); free(frames); ny_free_node(root); return false; }
        if (value_length != 0) { size_t next = 0; if (ny_next_content(parser, index + 1, &next) && parser->lines[next].indent > line->indent) { if (frame_count >= parser->max_depth) { free(frames); ny_free_node(root); return ny_fail(parser, "nesting limit exceeded"); } frames[frame_count++] = (NyFrame){map, parser->lines[next].indent, false}; } }
        index++; continue;
      }
      NyNode *value = NULL;
      if (rest_length > 0 && (rest[0] == '|' || rest[0] == '>')) { if (!ny_block_scalar(parser, line->indent, rest, rest_length, &value)) { free(frames); ny_free_node(root); return false; } index = parser->index; }
      else { char *joined = NULL; size_t joined_length = 0; if (rest_length > 0 && rest[0] == '\'' && !ny_single_quote_complete(rest, rest_length) && !ny_join_single_quoted(parser, &index, rest, rest_length, &joined, &joined_length)) { free(frames); ny_free_node(root); return false; } if (joined == NULL && rest_length > 0 && rest[0] == '"' && !ny_double_quote_complete(rest, rest_length) && !ny_join_double_quoted(parser, &index, rest, rest_length, &joined, &joined_length)) { free(frames); ny_free_node(root); return false; } if (joined != NULL) { bool parsed = ny_inline(parser, joined, joined_length, &value); free(joined); if (!parsed) { free(frames); ny_free_node(root); return false; } } else if (!ny_inline(parser, rest, rest_length, &value)) { free(frames); ny_free_node(root); return false; } }
      if (value == NULL || !ny_sequence_add(parser, frame->node, value)) { free(frames); ny_free_node(root); return false; } index++; continue;
    }
    size_t colon = 0; if (!ny_find_colon(line->text, line->length, false, &colon)) { free(frames); ny_free_node(root); return ny_fail(parser, "mapping entry expected"); }
    const char *key_source = line->text; size_t key_length = colon; ny_trim(&key_source, &key_length); NyNode *key_node = NULL; if (!ny_parse_scalar(parser, key_source, key_length, &key_node) || key_node->type != NY_STRING) { ny_free_node(key_node); free(frames); ny_free_node(root); return ny_fail(parser, "mapping key must be text"); } char *key = ny_copy(key_node->data.string.value, key_node->data.string.length); ny_free_node(key_node); if (key == NULL) { free(frames); ny_free_node(root); return ny_fail(parser, "out of memory"); }
    const char *value_source = line->text + colon + 1; size_t value_length = line->length - colon - 1; ny_trim(&value_source, &value_length); NyNode *value = NULL;
    if (value_length > 0 && (value_source[0] == '|' || value_source[0] == '>')) { if (!ny_block_scalar(parser, line->indent, value_source, value_length, &value)) { free(key); free(frames); ny_free_node(root); return false; } index = parser->index; }
    else if (value_length == 0) { size_t next = 0; if (ny_next_content(parser, index + 1, &next) && parser->lines[next].indent > line->indent) { if (!ny_choose_child(parser, index + 1, &value)) { free(key); free(frames); ny_free_node(root); return false; } if (frame_count >= parser->max_depth) { free(key); free(frames); ny_free_node(root); return ny_fail(parser, "nesting limit exceeded"); } frames[frame_count++] = (NyFrame){value, parser->lines[next].indent, value->type == NY_SEQUENCE}; } else value = ny_node(parser, NY_NULL); }
    else { char *joined = NULL; size_t joined_length = 0; if (value_length > 0 && value_source[0] == '\'' && !ny_single_quote_complete(value_source, value_length) && !ny_join_single_quoted(parser, &index, value_source, value_length, &joined, &joined_length)) { free(key); free(frames); ny_free_node(root); return false; } if (joined == NULL && value_length > 0 && value_source[0] == '"' && !ny_double_quote_complete(value_source, value_length) && !ny_join_double_quoted(parser, &index, value_source, value_length, &joined, &joined_length)) { free(key); free(frames); return false; } if (joined == NULL && ny_is_flow(value_source, value_length) && !ny_join_flow(parser, &index, value_source, value_length, &joined, &joined_length)) { free(key); free(frames); return false; } if (joined != NULL) { if (!ny_inline(parser, joined, joined_length, &value)) { free(joined); free(key); free(frames); return false; } free(joined); } else if (!ny_inline(parser, value_source, value_length, &value)) { free(key); free(frames); return false; } }
    if (value == NULL || !ny_map_add(parser, frame->node, key, value)) { free(key); free(frames); ny_free_node(root); return false; } index++;
  }
  free(frames); parser->index = index; *out = root; return true;
}

static bool ny_parse(NyParser *parser, const char *text, size_t length, NyNode **out) {
  if (parser == NULL || text == NULL || out == NULL) return false;
  if (!ny_lines(parser, text, length)) return false;
  if (parser->count == 0) return ny_fail(parser, "YAML document is empty");
  return ny_block(parser, out);
}

typedef struct { NyNode *node; napi_value parent; const char *key; uint32_t index; } NyConvert;

static bool ny_convert_push(NyConvert **stack, size_t *count, size_t *capacity, NyConvert task) {
  if (stack == NULL || *stack == NULL || count == NULL || capacity == NULL || *capacity == 0) return false;
  if (*count == *capacity) {
    if (*capacity >= NY_MAX_STACK) return false;
    size_t next_capacity = *capacity * 2;
    NyConvert *grown = realloc(*stack, sizeof(*grown) * next_capacity);
    if (grown == NULL) return false;
    *stack = grown;
    *capacity = next_capacity;
  }
  (*stack)[(*count)++] = task;
  return true;
}

static napi_status ny_attach(napi_env env, napi_value parent, const char *key, uint32_t index, napi_value value, bool array) {
  if (parent == NULL || value == NULL) return napi_invalid_arg;
  if (array) return napi_set_element(env, parent, index, value);
  napi_value property_key = NULL;
  if (napi_create_string_utf8(env, key, NAPI_AUTO_LENGTH, &property_key) != napi_ok) return napi_generic_failure;
  napi_property_descriptor descriptor = {NULL, property_key, NULL, NULL, NULL, value, napi_writable | napi_enumerable | napi_configurable, NULL};
  return napi_define_properties(env, parent, 1, &descriptor);
}

static napi_status ny_convert(napi_env env, NyNode *root, napi_value *out) {
  if (env == NULL || root == NULL || out == NULL) return napi_invalid_arg;
  size_t capacity = 64;
  NyConvert *stack = malloc(sizeof(*stack) * capacity);
  if (stack == NULL) return napi_generic_failure;
  size_t count = 1; stack[0] = (NyConvert){root, NULL, NULL, 0}; napi_value result = NULL;
  while (count > 0) {
    NyConvert task = stack[--count]; napi_value value = NULL;
    switch (task.node->type) {
      case NY_NULL: if (napi_get_null(env, &value) != napi_ok) { free(stack); return napi_generic_failure; } break;
      case NY_BOOL: if (napi_get_boolean(env, task.node->data.boolean, &value) != napi_ok) { free(stack); return napi_generic_failure; } break;
      case NY_NUMBER: if (napi_create_double(env, task.node->data.number, &value) != napi_ok) { free(stack); return napi_generic_failure; } break;
      case NY_STRING: if (napi_create_string_utf8(env, task.node->data.string.value, task.node->data.string.length, &value) != napi_ok) { free(stack); return napi_generic_failure; } break;
      case NY_SEQUENCE: if (napi_create_array_with_length(env, task.node->data.sequence.count, &value) != napi_ok) { free(stack); return napi_generic_failure; } break;
      case NY_MAP: if (napi_create_object(env, &value) != napi_ok) { free(stack); return napi_generic_failure; } break;
    }
    if (task.parent == NULL) result = value; else { bool parent_array = false; napi_is_array(env, task.parent, &parent_array); if (ny_attach(env, task.parent, task.key, task.index, value, parent_array) != napi_ok) { free(stack); return napi_generic_failure; } }
    if (task.node->type == NY_SEQUENCE) {
      for (size_t index = task.node->data.sequence.count; index > 0; index--) {
        NyConvert child = {task.node->data.sequence.items[index - 1], value, NULL, (uint32_t)(index - 1)};
        if (!ny_convert_push(&stack, &count, &capacity, child)) { free(stack); return napi_generic_failure; }
      }
    }
    if (task.node->type == NY_MAP) {
      for (size_t index = task.node->data.map.count; index > 0; index--) {
        NyConvert child = {task.node->data.map.items[index - 1].value, value, task.node->data.map.items[index - 1].key, 0};
        if (!ny_convert_push(&stack, &count, &capacity, child)) { free(stack); return napi_generic_failure; }
      }
    }
  }
  free(stack); *out = result; return napi_ok;
}

static bool ny_read_limit(napi_env env, napi_value options, const char *name, size_t *limit) {
  if (env == NULL || options == NULL || name == NULL || limit == NULL) return false;
  napi_value value = NULL; napi_valuetype type; double number;
  if (napi_get_named_property(env, options, name, &value) != napi_ok) return false;
  if (napi_typeof(env, value, &type) != napi_ok || type == napi_undefined) return true;
  if (type != napi_number || napi_get_value_double(env, value, &number) != napi_ok || !isfinite(number) || number < 1.0 || floor(number) != number || number > (double)SIZE_MAX) return false;
  size_t requested = (size_t)number;
  if (strcmp(name, "maxNodes") == 0 && requested > NY_MAX_NODES) return false;
  if (strcmp(name, "maxDepth") == 0 && requested > NY_MAX_DEPTH) return false;
  *limit = requested; return true;
}

static napi_value ny_parse_napi(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2]; if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) { napi_throw_error(env, NULL, "parse expects text"); return NULL; }
  if (argc > 2) { napi_throw_type_error(env, NULL, "parse accepts text and optional options only"); return NULL; }
  napi_valuetype type; if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string) { napi_throw_type_error(env, NULL, "text must be a string"); return NULL; }
  size_t length = 0; if (napi_get_value_string_utf8(env, argv[0], NULL, 0, &length) != napi_ok || length > NY_MAX_INPUT_BYTES) { napi_throw_range_error(env, NULL, "input is too large"); return NULL; }
  char *text = malloc(length + 1); if (text == NULL) { napi_throw_error(env, NULL, "out of memory"); return NULL; } size_t copied = 0; if (napi_get_value_string_utf8(env, argv[0], text, length + 1, &copied) != napi_ok) { free(text); napi_throw_error(env, NULL, "could not read input"); return NULL; } text[copied] = '\0';
  NyParser parser = {0}; parser.max_nodes = NY_MAX_NODES; parser.max_depth = NY_MAX_DEPTH; parser.error[0] = '\0';
  if (argc == 2) {
    napi_valuetype options_type;
    if (napi_typeof(env, argv[1], &options_type) != napi_ok || options_type != napi_object) { free(text); napi_throw_type_error(env, NULL, "options must be an object"); return NULL; }
    if (!ny_read_limit(env, argv[1], "maxNodes", &parser.max_nodes)) { free(text); napi_throw_range_error(env, NULL, "invalid maxNodes"); return NULL; }
    if (!ny_read_limit(env, argv[1], "maxDepth", &parser.max_depth)) { free(text); napi_throw_range_error(env, NULL, "invalid maxDepth"); return NULL; }
  }
  NyNode *root = NULL; bool ok = ny_parse(&parser, text, copied, &root); free(text); for (size_t index = 0; index < parser.count; index++) { free(parser.lines[index].text); free(parser.lines[index].raw); } free(parser.lines);
  if (!ok) { ny_free_node(root); napi_throw_error(env, NULL, parser.error[0] ? parser.error : "parse failed"); return NULL; }
  napi_value result = NULL; napi_status status = ny_convert(env, root, &result); ny_free_node(root); if (status != napi_ok) { napi_throw_error(env, NULL, "conversion failed"); return NULL; } return result;
}

static napi_value ny_init(napi_env env, napi_value exports) { napi_property_descriptor property = {"parseYaml", NULL, ny_parse_napi, NULL, NULL, NULL, napi_default, NULL}; if (napi_define_properties(env, exports, 1, &property) != napi_ok) return NULL; return exports; }
NAPI_MODULE(NODE_GYP_MODULE_NAME, ny_init)
